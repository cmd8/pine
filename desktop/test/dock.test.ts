// The tree that arranges a window's tabs (src/dock.ts): pure functions, no window.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dragEdge, leastOf, spans, windowEdgeOf, windowRect, findGroup, group, groupHolding, groupsOf, insert, itemsOf, layout, type Node, prune, remove, resize, restore, same, save, setFront, split, splitWindow, zoneOf } from "../src/dock.ts";

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

/** Whether two rects overlap by more than a rounding error. */
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

test("no group is drawn under its least, whatever shares were kept, and the room it lacks comes from the others", () => {
	const least = { row: 340, column: 160 };
	assert.deepEqual(spans([0.5, 0.5], 1000, [340, 340]), [500, 500]);
	assert.deepEqual(spans([0.05, 0.95], 1000, [340, 340]), [340, 660]);
	assert.deepEqual(spans([0.05, 0.05, 0.9], 1000, [100, 100, 100]), [100, 100, 800]);
	// Less room than the leasts together: each gets its least, scaled down alike, and the room is filled exactly.
	assert.deepEqual(spans([0.9, 0.1], 500, [400, 100]), [400, 100]);
	assert.deepEqual(spans([0.5, 0.5], 300, [400, 200]), [200, 100]);
	// A conversation beside a column of the side panel over the view: the column is as wide as the widest of the two.
	const right = { kind: "split", id: "col", dir: "column", children: [group(["code"]), group(["view"])], sizes: [0.5, 0.5] } as Node;
	assert.equal(leastOf(right, "row", least, 6), 340);
	assert.equal(leastOf(right, "column", least, 6), 326);
	assert.equal(leastOf({ kind: "split", id: "r", dir: "row", children: [group(["a"]), right], sizes: [0.5, 0.5] }, "row", least, 6), 686);
});

test("a layout kept with a group squeezed to nothing comes back with every group and edge where it can be seen and reached", () => {
	const least = { row: 340, column: 160 };
	// As the owner left it: the conversation's share all but gone, the side panel over the view at the right.
	const kept = { kind: "split", dir: "row", children: [{ kind: "group", items: ["c"] }, { kind: "split", dir: "column", children: [{ kind: "group", items: ["code"] }, { kind: "group", items: ["view"] }], sizes: [0.6, 0.4] }], sizes: [0.02, 0.98] };
	const t = restore(kept, (x) => (typeof x === "string" ? x : undefined))!;
	const area = { x: 6, y: 0, width: 1018, height: 800 };
	const at = layout(t, area, 6, least);
	const rects = groupsOf(t).map((g) => at.groups.get(g.id)!);
	for (const r of rects) assert.ok(r.width >= least.row - 1e-6 && r.height >= least.column - 1e-6, JSON.stringify(r));
	for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlaps(rects[i], rects[j]), JSON.stringify([rects[i], rects[j]]));
	// The edge between the conversation and the column lies between them, and a drag starts from the shares as drawn.
	const edge = at.handles.find((h) => h.dir === "row")!;
	const conv = at.groups.get(groupHolding(t, "c")!.id)!;
	assert.equal(edge.rect.x, conv.x + conv.width);
	assert.ok(edge.sizes[0] * edge.length >= least.row - 1e-6);
	assert.deepEqual(edge.least, [340, 340]);
	// Dragged left as far as it goes, the conversation stays at its least; dragged right, it grows from where it was seen.
	const left = dragEdge(edge.sizes, 0, -2000, edge.length, edge.least);
	assert.ok(Math.abs(left[0] * edge.length - 340) < 1e-6, String(left));
	const wider = dragEdge(edge.sizes, 0, 100, edge.length, edge.least);
	assert.ok(Math.abs(wider[0] * edge.length - 440) < 1e-6, String(wider));
});

test("splitting the conversation's group again and again, as a tab dragged to its edge does, never draws one group over another", () => {
	const least = { row: 340, column: 160 };
	const area = { x: 6, y: 0, width: 1018, height: 800 };
	let t: Node = splitWindow(group(["c"]), "right", "code", 0.36);
	for (let i = 0; i < 4; i++) {
		t = split(t, groupHolding(t, "c")!.id, "right", "code");
		const at = layout(t, area, 6, least);
		const rects = groupsOf(t).map((g) => at.groups.get(g.id)!);
		for (const r of rects) assert.ok(r.width >= least.row - 1e-6, `${i}: ${JSON.stringify(r)}`);
		for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) assert.ok(!overlaps(rects[a], rects[b]));
	}
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
