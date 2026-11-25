// The tree that arranges a window's tabs (src/dock.ts): pure functions, no window.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dragEdge, windowEdgeOf, windowRect, findGroup, group, groupHolding, groupsOf, insert, itemsOf, layout, type Node, prune, remove, resize, restore, same, save, setFront, split, splitWindow, zoneOf } from "../src/dock.ts";

/** The shape of a tree as text: `[a b*]` a group with b in front, `row(...)` and `col(...)` splits. */
const show = (n: Node): string => (n.kind === "group" ? `[${n.items.map((i) => (i === n.front ? `${i}*` : i)).join(" ")}]` : `${n.dir === "row" ? "row" : "col"}(${n.children.map(show).join(" ")})`);

test("a tab goes into a group before another, and comes to the front there", () => {
	const g = group(["a", "b", "c"], "a");
	assert.equal(show(insert(g, g.id, "c", "a")), "[c* a b]");
	assert.equal(show(insert(g, g.id, "d")), "[a b c d*]");
	assert.equal(show(insert(g, "nope", "d")), "[a* b c]");
});

test("splitting a group puts the tab beside it, and a split of the same direction takes it as a neighbour", () => {
	const g = group(["a", "b"], "a");
	const one = split(g, g.id, "right", "b");
	assert.equal(show(one), "row([a*] [b*])");
	const right = groupHolding(one, "b")!;
	const two = split(insert(one, right.id, "c"), right.id, "right", "c");
	// Not row([a] row([b] [c])): the inner row's children join the outer one.
	assert.equal(show(two), "row([a*] [b*] [c*])");
	assert.ok(Math.abs((two as { sizes: number[] }).sizes.reduce((x, y) => x + y) - 1) < 1e-9);
	const three = split(two, groupHolding(two, "a")!.id, "bottom", "c");
	assert.equal(show(three), "row(col([a*] [c*]) [b*])");
});

test("the only tab of a group cannot split its own group", () => {
	const g = group(["a"]);
	assert.equal(show(split(g, g.id, "left", "a")), "[a*]");
});

test("a group left empty goes, and a split left with one child is that child", () => {
	const g = group(["a", "b"], "a");
	const t = split(g, g.id, "right", "b");
	assert.equal(show(remove(t, "b")), "[a*]");
	const right = groupHolding(t, "b")!;
	assert.equal(show(insert(t, right.id, "a")), "[b a*]");
	// With nothing at all left, one empty group stays.
	assert.equal(show(remove(group(["a"]), "a")), "[]");
});

test("a group that goes leaves its room to its neighbour, and the others keep theirs", () => {
	const g = group(["a", "b", "c"], "a");
	const one = split(g, g.id, "right", "b", 0.5);
	const t = split(insert(one, groupHolding(one, "b")!.id, "c"), groupHolding(one, "b")!.id, "right", "c", 0.5);
	// a 0.5, b 0.25, c 0.25: b goes, and a (before it) takes its room.
	assert.equal(show(t), "row([a*] [b*] [c*])");
	const after = remove(t, "b") as { sizes: number[] };
	assert.deepEqual(after.sizes.map((x) => Math.round(x * 100)), [75, 25]);
	// The first goes: the one after it takes its room.
	assert.deepEqual((remove(t, "a") as { sizes: number[] }).sizes.map((x) => Math.round(x * 100)), [75, 25]);
});

test("the tab before the one that closes comes to the front", () => {
	const g = group(["a", "b", "c"], "b");
	assert.equal(show(remove(g, "b")), "[a* c]");
	assert.equal(show(remove(setFront(g, "a"), "a")), "[b* c]");
	assert.equal(show(remove(g, "c")), "[a b*]");
});

test("a tab put at an edge of the window spans that edge", () => {
	const g = group(["a", "b", "c"], "a");
	const t = split(g, g.id, "bottom", "b");
	assert.equal(show(splitWindow(t, "right", "c", 0.3)), "row(col([a*] [b*]) [c*])");
	const across = splitWindow(splitWindow(t, "right", "c"), "left", "a");
	assert.equal(show(across), "row([a*] [b*] [c*])");
});

test("where everything lies, and which sides of the window each group touches", () => {
	const g = group(["a", "b", "c"], "a");
	const t = split(split(g, g.id, "right", "b", 0.5), g.id, "bottom", "c", 0.5);
	const at = layout(t, { x: 0, y: 0, width: 1006, height: 806 }, 6);
	const [left, low, right] = [groupHolding(t, "a")!, groupHolding(t, "c")!, groupHolding(t, "b")!];
	assert.deepEqual(at.groups.get(left.id), { x: 0, y: 0, width: 500, height: 400 });
	assert.deepEqual(at.groups.get(low.id), { x: 0, y: 406, width: 500, height: 400 });
	assert.deepEqual(at.groups.get(right.id), { x: 506, y: 0, width: 500, height: 806 });
	assert.deepEqual(at.sides.get(left.id), { top: true, left: true, right: false, bottom: false });
	assert.deepEqual(at.sides.get(right.id), { top: true, left: false, right: true, bottom: true });
	assert.equal(at.handles.length, 2);
	assert.deepEqual(at.handles.find((h) => h.dir === "row")?.rect, { x: 500, y: 0, width: 6, height: 806 });
});

test("dragging an edge moves room between its neighbours, never below the least", () => {
	assert.deepEqual(dragEdge([0.5, 0.5], 0, 100, 1000, 200), [0.6, 0.4]);
	assert.deepEqual(dragEdge([0.5, 0.5], 0, 900, 1000, 200), [0.8, 0.2]);
	assert.deepEqual(dragEdge([0.5, 0.25, 0.25], 1, -900, 1000, 100), [0.5, 0.1, 0.4]);
	const t = split(group(["a", "b"]), groupsOf(group(["a", "b"]))[0].id, "right", "b");
	assert.equal(resize(t, "nope", [1]), t);
});

test("the band along the window's edges: only where the group touches the window, and only near it", () => {
	const area = { x: 0, y: 0, width: 1000, height: 800 };
	// The lower group of a window split in two: it touches the left, right and bottom of the window, not the top.
	const low = { x: 0, y: 450, width: 1000, height: 350 };
	const sides = { top: false, left: true, right: true, bottom: true };
	assert.equal(windowEdgeOf(sides, low, area, 10, 600, 48), "left");
	assert.equal(windowEdgeOf(sides, low, area, 990, 600, 48), "right");
	assert.equal(windowEdgeOf(sides, low, area, 500, 790, 48), "bottom");
	assert.equal(windowEdgeOf(sides, low, area, 500, 460, 48), undefined, "the top of this group is not the window's");
	assert.equal(windowEdgeOf(sides, low, area, 100, 600, 48), undefined, "too far in: the group's own left edge");
	// A small group keeps room for its own zones.
	assert.equal(windowEdgeOf(sides, { x: 0, y: 450, width: 100, height: 350 }, area, 30, 600, 48), undefined);
	assert.deepEqual(windowRect(area, "left"), { x: 0, y: 0, width: 350, height: 800 });
	assert.deepEqual(windowRect(area, "bottom"), { x: 0, y: 520, width: 1000, height: 280 });
});

test("the zone over a group: its edges, or the middle", () => {
	const r = { x: 0, y: 0, width: 400, height: 400 };
	assert.equal(zoneOf(r, 200, 200), "center");
	assert.equal(zoneOf(r, 20, 200), "left");
	assert.equal(zoneOf(r, 390, 200), "right");
	assert.equal(zoneOf(r, 200, 10), "top");
	assert.equal(zoneOf(r, 200, 395), "bottom");
	assert.equal(zoneOf(r, 10, 30), "left");
});

test("a tree is kept and read back, and what is no longer there is left out", () => {
	const g = group(["a", "b", "c"], "b");
	const t = split(g, g.id, "right", "c", 0.25);
	const kept = JSON.parse(JSON.stringify(save(t, (i) => (i === "a" ? undefined : { name: i }))));
	const back = restore(kept, (x) => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" ? (x as { name: string }).name : undefined))!;
	assert.equal(show(back), "row([b*] [c*])");
	assert.ok(Math.abs((back as { sizes: number[] }).sizes[1] - 0.25) < 1e-9);
	// Whatever cannot be a tree gives nothing; a tree whose items are all gone is one empty group.
	for (const bad of [null, 1, "x", [], { kind: "split", dir: "diagonal", children: [], sizes: [] }, { kind: "group" }]) assert.equal(restore(bad, () => "a"), undefined);
	assert.deepEqual(itemsOf(restore(kept, () => undefined)!), []);
	// Deeper than anyone arranges is not read: what lies below that depth is left out.
	let deep: unknown = { kind: "group", items: ["a"] };
	for (let i = 0; i < 20; i++) deep = { kind: "split", dir: i % 2 ? "row" : "column", children: [deep, { kind: "group", items: [`x${i}`] }], sizes: [1, 1] };
	const depthOf = (n: Node): number => (n.kind === "group" ? 0 : 1 + Math.max(...n.children.map(depthOf)));
	const read = restore(deep, (x) => (typeof x === "string" ? x : undefined))!;
	assert.ok(depthOf(read) <= 9);
	assert.ok(!itemsOf(read).includes("a"));
});

test("pruning keeps a group's id, and sizes add up to one", () => {
	const g = group(["a"]);
	const p = prune({ kind: "split", id: "s", dir: "row", children: [g, { kind: "group", id: "e", items: [] }], sizes: [3, 1] });
	assert.equal(p.id, g.id);
	assert.ok(findGroup(p, g.id));
	assert.deepEqual(itemsOf(p), ["a"]);
	assert.ok(same(p, g));
});
