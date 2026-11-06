import { expect, test } from "bun:test";
import { meanRecallAtK, recallAtK } from "../eval/index.js";

test("recall@k counts labeled refs in the top-N cards only", () => {
	const result = recallAtK(
		{ taskId: "t1", expectedRefs: ["skill:a", "skill:b"] },
		{
			taskId: "t1",
			retrievedRefs: ["skill:x", "skill:a", "skill:y", "skill:b"],
			k: 3,
		},
	);
	expect(result.hit).toEqual(["skill:a"]);
	expect(result.missed).toEqual(["skill:b"]);
	expect(result.recallAtK).toBe(0.5);
});

test("perfect recall when every expected ref is in the cutoff", () => {
	const result = recallAtK(
		{ taskId: "t2", expectedRefs: ["a", "b"] },
		{ taskId: "t2", retrievedRefs: ["a", "b", "c"], k: 2 },
	);
	expect(result.recallAtK).toBe(1);
	expect(meanRecallAtK([result])).toBe(1);
});

test("empty retrieval yields zero recall without inventing hits", () => {
	const result = recallAtK(
		{ taskId: "t3", expectedRefs: ["needed"] },
		{ taskId: "t3", retrievedRefs: [], k: 5 },
	);
	expect(result.recallAtK).toBe(0);
	expect(result.missed).toEqual(["needed"]);
});
