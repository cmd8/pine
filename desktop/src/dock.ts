// How a window's tabs are arranged: a tree of splits whose leaves are groups of tabs, as in VS Code. A group shows
// one of its tabs at a time (its front); a split lays its children side by side (a row) or one above the other (a
// column), each with its share of the room. What a tab is, this file does not know: an item is a string the store
// chose (a tab's id, or the name of a pane such as the side panel). Every function returns a new tree and leaves the
// one it was given as it was. No DOM and no React here: the tests run it in Node.

export type Edge = "left" | "right" | "top" | "bottom";

export interface Group {
	kind: "group";
	id: string;
	items: string[];
	front?: string;
}

export interface Split {
	kind: "split";
	id: string;
	dir: "row" | "column";
	children: Node[];
	/** Each child's share of the room, in the order of `children`; they add up to 1. */
	sizes: number[];
}

export type Node = Group | Split;

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The deepest a saved tree is read: deeper than anyone arranges by hand. */
const DEPTH = 8;
/** The most children of one split and items of one group that a saved tree may have. */
const WIDE = 16;
const ITEMS = 100;

let made = 0;
/** A new id for a group or a split: unique within the page, which is all that is asked of it. */
export const newId = (prefix: "g" | "s"): string => `${prefix}${Date.now().toString(36)}${(made++).toString(36)}`;

export function group(items: string[] = [], front?: string): Group {
	return { kind: "group", id: newId("g"), items: [...items], front: front ?? items[0] };
}

/** The groups of a tree, in the order they are drawn: left to right, top to bottom. */
export function groupsOf(node: Node): Group[] {
	return node.kind === "group" ? [node] : node.children.flatMap(groupsOf);
}

/** Every item of a tree, group after group. */
export function itemsOf(node: Node): string[] {
	return groupsOf(node).flatMap((g) => g.items);
}

export function findNode(node: Node, id: string): Node | undefined {
	if (node.id === id) return node;
	if (node.kind === "group") return undefined;
	for (const c of node.children) {
		const found = findNode(c, id);
		if (found) return found;
	}
	return undefined;
}

export function findGroup(node: Node, id: string): Group | undefined {
	return groupsOf(node).find((g) => g.id === id);
}

export function groupHolding(node: Node, item: string): Group | undefined {
	return groupsOf(node).find((g) => g.items.includes(item));
}

/** A copy of the tree with one node replaced by what `swap` makes of it. */
function mapNode(node: Node, id: string, swap: (n: Node) => Node): Node {
	if (node.id === id) return swap(node);
	if (node.kind === "group") return node;
	return { ...node, children: node.children.map((c) => mapNode(c, id, swap)) };
}

/** Shares that add up to 1, each at least a little, in proportion to what they were. */
function normal(sizes: number[]): number[] {
	const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
	const sum = clean.reduce((a, b) => a + b, 0);
	if (sum <= 0) return sizes.map(() => 1 / sizes.length);
	return clean.map((s) => s / sum);
}

/**
 * The tree tidied: empty groups go, a split left with one child is that child, a split inside a split of the same
 * direction gives its children to the outer one (in its share), and the front of each group is one of its items.
 * A tree with no item at all keeps one empty group, so that there is always somewhere to put a tab.
 */
export function prune(node: Node): Node {
	const kept = tidy(node);
	return kept ?? { kind: "group", id: node.kind === "group" ? node.id : groupsOf(node)[0]?.id ?? newId("g"), items: [] };
}

function tidy(node: Node): Node | undefined {
	if (node.kind === "group") {
		if (!node.items.length) return undefined;
		const items = [...new Set(node.items)];
		const front = node.front && items.includes(node.front) ? node.front : items[0];
		return { ...node, items, front };
	}
	// A child that goes leaves its room to its neighbour (the one before it, else the one after it), as in VS Code:
	// the others keep the size they had.
	const kept = node.children.map((c) => tidy(c));
	const shares = node.children.map((_, i) => node.sizes[i] ?? 1 / node.children.length);
	kept.forEach((t, i) => {
		if (t) return;
		const before = kept.slice(0, i).findLastIndex(Boolean);
		const after = kept.findIndex((k, j) => j > i && k);
		const to = before >= 0 ? before : after;
		if (to >= 0) ((shares[to] += shares[i]), (shares[i] = 0));
	});
	const children: Node[] = [];
	const sizes: number[] = [];
	kept.forEach((t, i) => {
		if (!t) return;
		const share = shares[i];
		if (t.kind === "split" && t.dir === node.dir) {
			t.children.forEach((cc, j) => (children.push(cc), sizes.push(share * t.sizes[j])));
		} else (children.push(t), sizes.push(share));
	});
	if (!children.length) return undefined;
	if (children.length === 1) return children[0];
	return { ...node, children, sizes: normal(sizes) };
}

/** The tree without `item`, wherever it was. */
export function remove(node: Node, item: string): Node {
	const holder = groupHolding(node, item);
	if (!holder) return node;
	return prune(
		mapNode(node, holder.id, (g) => {
			const was = (g as Group).items;
			const at = was.indexOf(item);
			const items = was.filter((i) => i !== item);
			// The tab beside the one that goes comes to the front: the one before it, else the one after it.
			const front = (g as Group).front === item ? items[Math.max(0, at - 1)] : (g as Group).front;
			return { ...(g as Group), items, front };
		}),
	);
}

/**
 * `item` put into the group `groupId`, before the item `before` (at the end without one), and brought to the front
 * there. Taken out of wherever it was first. A group that is not there takes nothing: the tree is as it was.
 */
export function insert(node: Node, groupId: string, item: string, before?: string): Node {
	if (!findGroup(node, groupId)) return node;
	const target = findGroup(node, groupId)!;
	// Out of its old place first, without tidying: the group it goes to must not vanish when it was its only item.
	let tree = node;
	const holder = groupHolding(node, item);
	if (holder) tree = mapNode(tree, holder.id, (g) => ({ ...(g as Group), items: (g as Group).items.filter((i) => i !== item) }));
	tree = mapNode(tree, target.id, (g) => {
		const items = (g as Group).items.filter((i) => i !== item);
		const at = before ? items.indexOf(before) : -1;
		items.splice(at < 0 ? items.length : at, 0, item);
		return { ...(g as Group), items, front: item };
	});
	return prune(tree);
}

/** The item in front of its group. */
export function setFront(node: Node, item: string): Node {
	const holder = groupHolding(node, item);
	if (!holder || holder.front === item) return node;
	return mapNode(node, holder.id, (g) => ({ ...(g as Group), front: item }));
}

const dirOf = (edge: Edge): Split["dir"] => (edge === "left" || edge === "right" ? "row" : "column");
const first = (edge: Edge) => edge === "left" || edge === "top";

/**
 * `item` taken out of where it was and put into a new group at one edge of the group `groupId`, which gives up
 * `share` of its room for it. Where that group lies in a split of the same direction, the new group becomes its
 * neighbour there instead of a split of its own. An item that is the only one of its group cannot split that group:
 * the tree is as it was.
 */
export function split(node: Node, groupId: string, edge: Edge, item: string, share = 0.5): Node {
	const target = findGroup(node, groupId);
	if (!target) return node;
	if (target.items.length === 1 && target.items[0] === item) return node;
	const fresh = group([item]);
	// Out of its old place, without tidying: the target keeps its id and its place even if this empties a neighbour.
	let tree = node;
	const holder = groupHolding(node, item);
	if (holder) tree = mapNode(tree, holder.id, (g) => {
		const items = (g as Group).items.filter((i) => i !== item);
		return { ...(g as Group), items, front: (g as Group).front === item ? items[0] : (g as Group).front };
	});
	const dir = dirOf(edge);
	const parent = parentOf(tree, groupId);
	if (parent && parent.dir === dir) {
		tree = mapNode(tree, parent.id, (p) => {
			const sp = p as Split;
			const at = sp.children.findIndex((c) => c.id === groupId);
			const children = [...sp.children];
			const sizes = [...sp.sizes];
			const whole = sizes[at];
			sizes[at] = whole * (1 - share);
			const put = first(edge) ? at : at + 1;
			children.splice(put, 0, fresh);
			sizes.splice(put, 0, whole * share);
			return { ...sp, children, sizes };
		});
	} else {
		tree = mapNode(tree, groupId, (g) => ({
			kind: "split",
			id: newId("s"),
			dir,
			children: first(edge) ? [fresh, g] : [g, fresh],
			sizes: first(edge) ? [share, 1 - share] : [1 - share, share],
		}));
	}
	return prune(tree);
}

/** `item` taken out of where it was and put into a new group along one edge of the whole window, with `share` of it. */
export function splitWindow(node: Node, edge: Edge, item: string, share = 0.3): Node {
	const fresh = group([item]);
	const rest = prune(remove(node, item));
	if (!itemsOf(rest).length) return fresh;
	const dir = dirOf(edge);
	if (rest.kind === "split" && rest.dir === dir) {
		const sizes = rest.sizes.map((s) => s * (1 - share));
		return first(edge) ? { ...rest, children: [fresh, ...rest.children], sizes: [share, ...sizes] } : { ...rest, children: [...rest.children, fresh], sizes: [...sizes, share] };
	}
	return { kind: "split", id: newId("s"), dir, children: first(edge) ? [fresh, rest] : [rest, fresh], sizes: first(edge) ? [share, 1 - share] : [1 - share, share] };
}

export function parentOf(node: Node, id: string): Split | undefined {
	if (node.kind === "group") return undefined;
	for (const c of node.children) {
		if (c.id === id) return node;
		const found = parentOf(c, id);
		if (found) return found;
	}
	return undefined;
}

/** The shares of a split's children set anew (the edge between two of them was dragged). */
export function resize(node: Node, splitId: string, sizes: number[]): Node {
	return mapNode(node, splitId, (s) => (s.kind === "split" && sizes.length === s.children.length ? { ...s, sizes: normal(sizes) } : s));
}

/** Where the edge between two neighbours of a split lies, and which: dragged, it moves the room from one to the other. */
export interface Handle {
	split: string;
	/** The edge after this child. */
	index: number;
	dir: Split["dir"];
	rect: Rect;
	/** The rect of the whole split, which its shares are of. */
	whole: Rect;
}

/** Which sides of the window a group touches: the top row carries the title bar, the corners the window's buttons. */
export interface Sides {
	top: boolean;
	left: boolean;
	right: boolean;
	bottom: boolean;
}

/**
 * Where everything lies in `rect`: each group's rect, the edges between neighbours (`gap` wide), and which sides of
 * the window each group touches. Only arithmetic: the page draws what it says.
 */
export function layout(node: Node, rect: Rect, gap: number): { groups: Map<string, Rect>; handles: Handle[]; sides: Map<string, Sides> } {
	const groups = new Map<string, Rect>();
	const sides = new Map<string, Sides>();
	const handles: Handle[] = [];
	const walk = (n: Node, r: Rect, s: Sides) => {
		if (n.kind === "group") return void (groups.set(n.id, r), sides.set(n.id, s));
		const row = n.dir === "row";
		const length = (row ? r.width : r.height) - gap * (n.children.length - 1);
		let at = row ? r.x : r.y;
		n.children.forEach((c, i) => {
			const span = Math.max(0, length * n.sizes[i]);
			const part: Rect = row ? { x: at, y: r.y, width: span, height: r.height } : { x: r.x, y: at, width: r.width, height: span };
			const last = i === n.children.length - 1;
			walk(c, part, row ? { ...s, left: s.left && i === 0, right: s.right && last } : { ...s, top: s.top && i === 0, bottom: s.bottom && last });
			at += span;
			if (!last) {
				handles.push({ split: n.id, index: i, dir: n.dir, rect: row ? { x: at, y: r.y, width: gap, height: r.height } : { x: r.x, y: at, width: r.width, height: gap }, whole: r });
				at += gap;
			}
		});
	};
	walk(node, rect, { top: true, left: true, right: true, bottom: true });
	return { groups, handles, sides };
}

/**
 * The shares of a split after the edge `index` was dragged by `delta` pixels, with no child narrower than `least`
 * pixels (as far as the two beside the edge allow). Only the two neighbours of the edge change.
 */
export function dragEdge(sizes: number[], index: number, delta: number, length: number, least: number): number[] {
	if (length <= 0 || index < 0 || index >= sizes.length - 1) return sizes;
	const a = sizes[index] * length;
	const b = sizes[index + 1] * length;
	const floor = Math.min(least, (a + b) / 2);
	const moved = Math.max(floor - a, Math.min(b - floor, delta));
	const next = [...sizes];
	next[index] = (a + moved) / length;
	next[index + 1] = (b - moved) / length;
	return next;
}

/** Where over a group's body a dragged tab would go: into it ("center"), or into a new group at one of its edges. */
export type Zone = "center" | Edge;

/**
 * The zone of a point over a rect: the outer quarter on each side is that edge, the middle is the group itself. A
 * corner is the edge the point lies nearer to.
 */
export function zoneOf(rect: Rect, x: number, y: number): Zone {
	const fx = (x - rect.x) / Math.max(1, rect.width);
	const fy = (y - rect.y) / Math.max(1, rect.height);
	const edges: Array<[Edge, number]> = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
	const [edge, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
	return d < 0.25 ? edge : "center";
}

/** The part of a group's rect a zone would take, for the mark shown while a tab is dragged over it. */
export function zoneRect(rect: Rect, zone: Zone): Rect {
	const { x, y, width: w, height: h } = rect;
	switch (zone) {
		case "left":
			return { x, y, width: w / 2, height: h };
		case "right":
			return { x: x + w / 2, y, width: w / 2, height: h };
		case "top":
			return { x, y, width: w, height: h / 2 };
		case "bottom":
			return { x, y: y + h / 2, width: w, height: h / 2 };
		default:
			return rect;
	}
}

/** A tree as it is kept: the same shape, with each item as the store writes it (a conversation's name, a pane's). */
export type Saved<T> = { kind: "group"; items: T[]; front?: number } | { kind: "split"; dir: "row" | "column"; children: Saved<T>[]; sizes: number[] };

/** A tree to keep: items through `save` (an item that gives nothing is left out, a tab that is not kept). */
export function save<T>(node: Node, keep: (item: string) => T | undefined): Saved<T> {
	if (node.kind === "group") {
		const kept = node.items.map((i) => [i, keep(i)] as const).filter((p): p is readonly [string, T] => p[1] !== undefined);
		const front = kept.findIndex(([i]) => i === node.front);
		return { kind: "group", items: kept.map(([, t]) => t), ...(front >= 0 ? { front } : {}) };
	}
	return { kind: "split", dir: node.dir, children: node.children.map((c) => save(c, keep)), sizes: [...node.sizes] };
}

/**
 * A kept tree read back, from a file or another process, and checked as it is read: its shape, its depth, how many
 * children and items. Each item goes through `read`, which says what it is now (a tab's id) or that it is gone.
 * Nothing but a valid tree comes out; what cannot be read gives `undefined`.
 */
export function restore(raw: unknown, read: (item: unknown) => string | undefined, depth = 0): Node | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > DEPTH) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.kind === "group") {
		if (!Array.isArray(r.items)) return undefined;
		const raws = r.items.slice(0, ITEMS);
		const items: string[] = [];
		let front: string | undefined;
		raws.forEach((x, i) => {
			const item = read(x);
			if (item === undefined || items.includes(item)) return;
			items.push(item);
			if (r.front === i) front = item;
		});
		return { kind: "group", id: newId("g"), items, front: front ?? items[0] };
	}
	if (r.kind === "split") {
		if ((r.dir !== "row" && r.dir !== "column") || !Array.isArray(r.children) || !Array.isArray(r.sizes) || r.children.length !== r.sizes.length || r.children.length > WIDE) return undefined;
		const children: Node[] = [];
		const sizes: number[] = [];
		r.children.forEach((c, i) => {
			const n = restore(c, read, depth + 1);
			const s = Number((r.sizes as unknown[])[i]);
			if (n) (children.push(n), sizes.push(Number.isFinite(s) && s > 0 ? s : 0));
		});
		if (!children.length) return undefined;
		return prune({ kind: "split", id: newId("s"), dir: r.dir, children, sizes: normal(sizes) });
	}
	return undefined;
}

/** Whether two trees are drawn the same: the same shape, items and fronts (ids and tiny differences in share aside). */
export function same(a: Node, b: Node): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "group") return b.kind === "group" && a.front === b.front && a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i]);
	if (b.kind !== "split" || a.dir !== b.dir || a.children.length !== b.children.length) return false;
	return a.children.every((c, i) => same(c, b.children[i]) && Math.abs(a.sizes[i] - b.sizes[i]) < 1e-6);
}

/**
 * A kept tree checked as it is passed on (from the page to the main process, from a file back to the page), with no
 * ids made: the same shape and limits as `restore`, each item through `item`, which says what it is or that it is not
 * one. Nothing but a valid kept tree comes out.
 */
export function cleanSaved<T>(raw: unknown, item: (x: unknown) => T | undefined, depth = 0): Saved<T> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > DEPTH) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.kind === "group") {
		if (!Array.isArray(r.items)) return undefined;
		const items = r.items.slice(0, ITEMS).map(item).filter((x): x is T => x !== undefined);
		const front = Number.isInteger(r.front) && (r.front as number) >= 0 && (r.front as number) < items.length ? (r.front as number) : undefined;
		return { kind: "group", items, ...(front !== undefined ? { front } : {}) };
	}
	if (r.kind === "split") {
		if ((r.dir !== "row" && r.dir !== "column") || !Array.isArray(r.children) || !Array.isArray(r.sizes) || r.children.length !== r.sizes.length || r.children.length > WIDE) return undefined;
		const children: Saved<T>[] = [];
		const sizes: number[] = [];
		r.children.forEach((c, i) => {
			const n = cleanSaved(c, item, depth + 1);
			const s = Number((r.sizes as unknown[])[i]);
			if (n) (children.push(n), sizes.push(Number.isFinite(s) && s > 0 ? s : 0));
		});
		if (!children.length) return undefined;
		return { kind: "split", dir: r.dir, children, sizes: normal(sizes) };
	}
	return undefined;
}
