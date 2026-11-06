import { expect, test } from "bun:test";
import { compareDisclosureRounds } from "../eval/index.js";
import { fixture } from "./fixture.js";

test("disclose unknown-only refs become repairable failures", async () => {
	const f = fixture();
	const turns = [
		{ kind: "disclose", items: [{ ref: "missing:1", sectionIds: ["x"] }] },
		{
			kind: "needs_input",
			missing: ["根拠が足りない"],
		},
	];
	let i = 0;
	const seen: any[] = [];
	f.ports.inference.complete = async (input) => {
		seen.push(structuredClone(input.data));
		return {
			value: turns[i++]!,
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		};
	};
	f.request.limits.modelCalls = 3;
	const pending = f.submit();
	const work = await f.run(pending.requestRef!);
	expect(work.result.decision.kind).toBe("needs_input");
	expect(seen[1].repair?.code).toBe("disclose_unknown");
});

test("duplicate disclose reports duplicateOnly with zero added bytes", async () => {
	const f = fixture();
	const turns = [
		{
			kind: "disclose",
			items: [{ ref: "skill:compare@1", sectionIds: ["inspect"] }],
		},
		{
			kind: "disclose",
			items: [{ ref: "skill:compare@1", sectionIds: ["inspect"] }],
		},
		{ kind: "unavailable", code: "end" },
	];
	let i = 0;
	const seen: any[] = [];
	f.ports.inference.complete = async (input) => {
		seen.push(structuredClone(input.data));
		return {
			value: turns[i++]!,
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		};
	};
	f.request.limits.modelCalls = 4;
	const pending = f.submit();
	await f.run(pending.requestRef!);
	expect(seen[1].disclosureProgress.rounds).toBe(1);
	expect(seen[1].disclosureProgress.last.duplicateOnly).toBe(false);
	expect(seen[2].disclosureProgress.rounds).toBe(2);
	expect(seen[2].disclosureProgress.last.duplicateOnly).toBe(true);
	expect(seen[2].disclosureProgress.last.addedBytes).toBe(0);
});

test("compareDisclosureRounds measures bytes without inventing quality", () => {
	const cmp = compareDisclosureRounds({
		totalModelCalls: 3,
		oneRound: {
			discloseCalls: 1,
			readyOrTerminalCalls: 1,
			disclosedBytes: 100,
			unusedDisclosedSectionIds: ["long#tail"],
		},
		twoRounds: {
			discloseCalls: 2,
			readyOrTerminalCalls: 1,
			disclosedBytes: 160,
			unusedDisclosedSectionIds: [],
		},
	});
	expect(cmp.deltas.extraDiscloseBytes).toBe(60);
	expect(cmp.deltas.twoRoundsExhaustedBudget).toBe(true);
	expect(cmp.deltas.oneRoundExhaustedBudget).toBe(false);
	expect(cmp.method).toBe("disclosure_round_compare_v1");
});
