import { test, expect } from "bun:test";
import { qualityV11Schema } from "../eval/quality-v11.js";
const r = {
	score: 100,
	correctness: 35,
	actionability: 25,
	coverage: 20,
	concision: 10,
	format: 10,
	reasons: {
		correctness: "a",
		actionability: "a",
		coverage: "a",
		concision: "a",
		format: "a",
	},
	incorrectExamples: [],
};
test("v11 weighted rubric has exact sum and criterion-specific reasons", () => {
	expect(qualityV11Schema.safeParse(r).success).toBe(true);
	expect(qualityV11Schema.safeParse({ ...r, score: 99 }).success).toBe(false);
	expect(
		qualityV11Schema.safeParse({ ...r, reasons: { ...r.reasons, format: "" } })
			.success,
	).toBe(false);
});
test("v11 incorrect concrete examples have a strict cap", () => {
	expect(
		qualityV11Schema.safeParse({ ...r, incorrectExamples: ["wrong API"] })
			.success,
	).toBe(false);
});
