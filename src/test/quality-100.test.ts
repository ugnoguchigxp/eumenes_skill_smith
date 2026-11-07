import { expect, test } from "bun:test";
import { quality100Schema } from "../eval/quality-100.js";
const valid = {
	score: 80,
	correctness: 38,
	actionability: 20,
	coverage: 18,
	concision: 4,
	incorrectExamples: [],
	rationale: "Grok Bot recorded judgment",
};
test("100-point rubric enforces integer weights and exact sum without changing legacy scales", () => {
	expect(quality100Schema.safeParse(valid).success).toBe(true);
	for (const v of [
		{ ...valid, score: 81 },
		{ ...valid, correctness: 41 },
		{ ...valid, concision: 4.5 },
		{ ...valid, coverage: 21 },
	])
		expect(quality100Schema.safeParse(v).success).toBe(false);
});
test("incorrect concrete examples cap both correctness and total, fail closed", () => {
	expect(
		quality100Schema.safeParse({ ...valid, incorrectExamples: ["wrong API"] })
			.success,
	).toBe(false);
	expect(
		quality100Schema.safeParse({
			...valid,
			score: 50,
			correctness: 15,
			actionability: 15,
			coverage: 15,
			concision: 5,
			incorrectExamples: ["wrong API"],
		}).success,
	).toBe(true);
});
