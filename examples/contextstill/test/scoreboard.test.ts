import { expect, test } from "bun:test";
import { INSTRUCTION_VERSION } from "../../../src/instructions/build.js";
import { buildScoreboard, renderText } from "../scoreboard.js";

const b = buildScoreboard();
const cell = (slice: string, p: "handle" | "bm25") =>
	b.slices.find((s) => s.id === slice)!.cells.find((c) => c.profile === p)!;

test("61 tasks in six slices, no blended mean", () => {
	expect(b.totalTasks).toBe(61);
	expect(b.slices.map((s) => [s.id, s.n])).toEqual([
		["retrieval/original", 5],
		["retrieval/exact", 16],
		["retrieval/en", 16],
		["retrieval/jp", 16],
		["compose", 4],
		["absent", 4],
	]);
	expect(b.blendedMean).toBeNull();
	expect(Object.keys(b)).not.toContain("meanScore");
	expect(renderText(b)).not.toMatch(/全体平均\s*[0-9]/);
});

test("original five handle 4.2 (9,9,1,1,1), hit@8 2/5", () => {
	const c = cell("retrieval/original", "handle");
	expect(c.meanScore).toBe(4.2);
	expect(c.scores.map((s) => s.score)).toEqual([9, 9, 1, 1, 1]);
	expect(c.hitAt8).toEqual({ hit: 2, of: 5 });
	expect(c.scoreSourceSuite).toBe("seed-skill-assembly");
});

test("original five bm25 8.6 (9,9,9,9,7), hit@8 5/5", () => {
	const c = cell("retrieval/original", "bm25");
	expect(c.meanScore).toBe(8.6);
	expect(c.scores.map((s) => s.score)).toEqual([9, 9, 9, 9, 7]);
	expect(c.hitAt8).toEqual({ hit: 5, of: 5 });
});

test("exact handle SKILL mean 2 (two 9s and fourteen 1s), hit@8 2/16", () => {
	const c = cell("retrieval/exact", "handle");
	expect(c.scored).toBe(16);
	expect(c.meanScore).toBe(2);
	expect(c.scores.map((s) => s.score)).toEqual([
		9, 9, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	]);
	expect(c.hitAt8).toEqual({ hit: 2, of: 16 });
});

test("slices without SKILL records report 0/n and null mean", () => {
	expect([
		cell("retrieval/exact", "bm25").scored,
		cell("retrieval/exact", "bm25").meanScore,
	]).toEqual([0, null]);
	for (const id of ["retrieval/en", "retrieval/jp"])
		for (const p of ["handle", "bm25"] as const) {
			const c = cell(id, p);
			expect([c.scored, c.unscored, c.meanScore]).toEqual([0, 16, null]);
			expect(c.hitAt8).not.toBeNull();
		}
	expect([
		cell("absent", "bm25").scored,
		cell("absent", "bm25").meanScore,
	]).toEqual([0, null]);
});

test("compose handle 1, bm25 8; absent handle 8", () => {
	expect(cell("compose", "handle").meanScore).toBe(1);
	expect(cell("compose", "bm25").meanScore).toBe(8);
	expect(cell("absent", "handle").meanScore).toBe(8);
});

test("build instruction version unchanged", () => {
	expect(INSTRUCTION_VERSION).toBe(
		"build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623",
	);
});
