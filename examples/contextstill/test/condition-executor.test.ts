import { test, expect } from "bun:test";
import { runGuidedExecutor } from "../condition-executor.js";

test("a delivered question preserves missing information and never runs the executor", async () => {
	let calls = 0;
	const missing = [
		"Provide the verified target",
		"Provide the authorization evidence",
	];
	const result = await runGuidedExecutor(
		{ kind: "needs_input", missing },
		async () => {
			calls++;
			return {
				kind: "ready",
				answer: "unsafe fallback",
				inputTokens: 1,
				outputTokens: 1,
			};
		},
	);
	expect(calls).toBe(0);
	expect(result).toMatchObject({
		kind: "needs_input",
		missing,
		executed: false,
		answer: missing.join("\n"),
		inputTokens: 0,
		outputTokens: 0,
	});
});
test("generation failures stay failures; ready guidance runs exactly once", async () => {
	let calls = 0;
	const execute = async () => {
		calls++;
		return {
			kind: "ready" as const,
			answer: "plan",
			inputTokens: 2,
			outputTokens: 3,
		};
	};
	for (const kind of ["unavailable", "rejected", "error"] as const)
		expect(
			await runGuidedExecutor({ kind, code: "origin_failure" }, execute),
		).toMatchObject({ kind, code: "origin_failure", executed: false });
	expect(calls).toBe(0);
	expect(await runGuidedExecutor({ kind: "ready" }, execute)).toMatchObject({
		kind: "ready",
		answer: "plan",
		executed: true,
		inputTokens: 2,
		outputTokens: 3,
	});
	expect(calls).toBe(1);
});
