import { expect, test } from "bun:test";
import { runFull, runRetrievalOnly } from "../scenario-runner.js";
import { recordedInference } from "../recorded.js";
import type { NormalizedScenarioTask } from "../../../src/eval/scenario-score.js";
import { handle, setup } from "./fixture.js";

const task = (
	over: Partial<NormalizedScenarioTask>,
): NormalizedScenarioTask => ({
	id: "t",
	axis: "retrieval",
	queryStyle: "exact",
	goal: "検証",
	acceptance: [{ id: "a", text: "x" }],
	expectedRefs: [],
	expectedTitles: [],
	nearestFalseFriendRefs: [],
	tags: [],
	legacy: null,
	...over,
});

test("retrieval-only makes zero inference calls and reports per-ref ranks", async () => {
	const f = setup();
	// The runner takes no inference port; spy the SourcePort to prove it only searches
	// (a builder or judge run would also call get/validate).
	const calls: string[] = [];
	const source = {
		search: (...a: Parameters<typeof f.source.search>) => (
			calls.push("search"),
			f.source.search(...a)
		),
		get: (...a: Parameters<typeof f.source.get>) => (
			calls.push("get"),
			f.source.get(...a)
		),
		validate: (...a: Parameters<typeof f.source.validate>) => (
			calls.push("validate"),
			f.source.validate(...a)
		),
	};
	const first = (await f.source.search("検証", 1, f.signal)).cards[0]!.ref;
	const rows = await runRetrievalOnly(
		[
			task({ id: "hit", expectedRefs: [first], expectedTitles: ["x"] }),
			task({
				id: "compose",
				axis: "compose",
				queryStyle: null,
				expectedRefs: [first, `contextstill:${handle("z")}`],
				expectedTitles: ["x", "y"],
			}),
			task({ id: "absent", axis: "absent", queryStyle: null }),
		],
		source,
	);
	expect(calls).toEqual(["search", "search", "search"]);
	expect(rows.map((r) => r.allRequiredHitAt8)).toEqual([true, false, null]);
	expect(rows[1]!.ranks[0]!.rank).toBe(1);
	expect(rows[1]!.ranks[1]!.rank).toBeNull();
});

test("full mode with missing records is incomplete and withholds the mean", async () => {
	const f = setup();
	let created = 0;
	const result = await runFull({
		tasks: [
			task({
				id: "p",
				expectedRefs: ["contextstill:kn_x"],
				expectedTitles: ["x"],
			}),
		],
		source: f.source,
		createInference: (_role, onTask) => {
			created++;
			return recordedInference([], onTask);
		},
		hasBuildRecord: () => false,
	});
	expect(created).toBeGreaterThan(0);
	expect(result.complete).toBe(false);
	expect(result.meanScore).toBeNull();
	expect(result.statuses[0]!.status).toBe("awaiting_build_inference");
});
