import { digest } from "../../../src/service/identity.js";
import { expect, test } from "bun:test";
import { disclosureInstructions } from "../../../src/instructions/build.js";
import {
	buildScoreboard,
	renderText,
	validateScoreRows,
	currentIdentityMatches,
	artifactBindingsValid,
} from "../scoreboard.js";

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

test("scoreboard retains the archived build instruction version", () => {
	expect("build." + digest(disclosureInstructions)).toBe(
		"build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623",
	);
});

test("product default SKILL scores stay off the two-column board and out of the 61 total", () => {
	expect(b.totalTasks).toBe(61);
	expect(b.blendedMean).toBeNull();
	const exact = b.slices.find((s) => s.id === "retrieval/exact")!
		.productDefault!.historicalSnapshot;
	expect(exact.scored).toBe(16);
	expect(exact.meanScore).toBe(8.88);
	expect(exact.scores.map((s) => s.score)).toEqual([
		9, 9, 9, 9, 7, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
	]);
	expect(exact.hitAt8).toEqual({ hit: 16, of: 16 });
	const en = b.slices.find((s) => s.id === "retrieval/en")!.productDefault!
		.historicalSnapshot;
	expect(en.meanScore).toBe(8);
	expect(en.scores.map((s) => s.score)).toEqual([
		9, 9, 9, 9, 9, 9, 9, 1, 9, 9, 9, 9, 9, 9, 9, 1,
	]);
	const jp = b.slices.find((s) => s.id === "retrieval/jp")!.productDefault!
		.historicalSnapshot;
	expect(jp.meanScore).toBe(8.5);
	expect(jp.scores.map((s) => s.score)).toEqual([
		9, 9, 9, 9, 9, 9, 9, 1, 9, 9, 9, 9, 9, 9, 9, 9,
	]);
	expect(
		b.slices.find((s) => s.id === "retrieval/original")!.productDefault!
			.meanScore,
	).toBeNull();
	expect(
		b.slices.find((s) => s.id === "compose")!.productDefault!.meanScore,
	).toBeNull();
	expect(cell("retrieval/exact", "handle").meanScore).toBe(2);
	expect(cell("retrieval/exact", "bm25").meanScore).toBeNull();
	expect(b.diverseCompanion?.n).toBe(10);
	expect(b.diverseCompanion?.historicalSnapshot.meanScore).toBe(9);
	expect(
		b.diverseCompanion?.historicalSnapshot.scores.map(
			(s: { score: number | null }) => s.score,
		),
	).toEqual([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
	const text = renderText(b);
	expect(text).not.toMatch(/SKILL点は未再生/);
	expect(text).not.toMatch(/全体平均\s*[0-9]/);
	expect(text).toMatch(/別枠 suite-diverse（10 件、61 件には含めない）/);
});

test("M1 current scoreboard does not relabel stale historical scores", () => {
	for (const s of b.slices) {
		for (const c of s.currentCells) expect(c.meanScore).toBeNull();
		if (s.productDefault)
			expect([s.productDefault.scored, s.productDefault.meanScore]).toEqual([
				0,
				null,
			]);
	}
	expect(b.diverseCompanion?.status).toBe("stale");
	expect(renderText(b)).toContain("未測定");
	const expected = {
		buildInstructionsDigest: "a",
		rendererVersion: "b",
		suiteFileSha256: "c",
		seedFileSha256: "d",
		evidenceSupply: "natural",
	};
	expect(currentIdentityMatches({ ...expected }, expected)).toBe(true);
	for (const key of Object.keys(expected)) {
		const bad = { ...expected } as any;
		delete bad[key];
		expect(currentIdentityMatches(bad, expected)).toBe(false);
		bad[key] = "changed";
		expect(currentIdentityMatches(bad, expected)).toBe(false);
	}
});
test("M1 score snapshots reject duplicate missing and out-of-range values", () => {
	for (const scores of [
		[
			{ taskId: "x", score: 9 },
			{ taskId: "x", score: 9 },
		],
		[],
		[{ taskId: "x", score: 11 }],
		[{ taskId: "x", score: -1 }],
		[{ taskId: "x", score: 1.2 }],
	])
		expect(() => validateScoreRows({ scores }, ["x"])).toThrow();
});

test("M6 current score binding refuses mismatched final artifact or judge provenance", () => {
	const hash = "a".repeat(64);
	const report = {
		identity: { artifactDigests: { t: hash } },
		scores: [{ taskId: "t", kind: "ready", artifactDigest: hash }],
		recordProvenance: [
			{
				taskId: "t",
				artifactDigest: hash,
				judgeArtifactDigest: hash,
				judgeRecordPresent: true,
			},
		],
	};
	expect(artifactBindingsValid(report)).toBe(true);
	for (const target of [
		report.identity.artifactDigests,
		report.scores[0]!,
		report.recordProvenance[0]!,
	]) {
		const bad = structuredClone(report);
		if (target === report.identity.artifactDigests)
			bad.identity.artifactDigests.t = "b".repeat(64);
		else if (target === report.scores[0])
			bad.scores[0]!.artifactDigest = "b".repeat(64);
		else bad.recordProvenance[0]!.judgeArtifactDigest = "b".repeat(64);
		expect(artifactBindingsValid(bad)).toBe(false);
	}
});
