import { expect, test } from "bun:test";
import {
	runAgentSkillsBaseline,
	discloseEvidence,
	evidenceCardView,
} from "../eval/index.js";
import type { Evidence } from "../index.js";

const evidence: Evidence[] = [
	{
		ref: "skill:compare@1",
		version: { id: "compare", version: "1", digest: "d", generation: 0 },
		title: "比較",
		body: "全文の手順。",
		sections: [
			{ id: "inspect", body: "正本を確認する。" },
			{ id: "compare", body: "差異を対応付ける。" },
		],
		status: "active",
		complete: true,
		external: false,
		scope: "shared",
	},
	{
		ref: "doc:plain@1",
		version: { id: "plain", version: "1", digest: "p", generation: 0 },
		title: "無区分",
		body: "section ID のない本文。",
		status: "active",
		complete: true,
		external: false,
		scope: "shared",
	},
];

test("baseline discloses then applies using the same evidence set", async () => {
	const turns = [
		{
			kind: "disclose",
			items: [{ ref: "skill:compare@1", sectionIds: ["inspect"] }],
		},
		{ kind: "apply", refs: ["skill:compare@1"], notes: "検査だけ使う" },
	];
	let i = 0;
	const result = await runAgentSkillsBaseline(
		{
			inference: {
				complete: async () => ({
					value: turns[i++]!,
					inputTokens: 3,
					outputTokens: 2,
				}),
			},
			now: () => 1_000_000,
		},
		{
			task: {
				goal: "資料の相違を確認する",
				acceptance: [{ id: "a1", text: "差異が説明されている" }],
			},
			cards: evidence.map(({ body: _b, sections: _s, ...c }) => c),
			evidence,
			requestRef: "eval:1",
		},
		new AbortController().signal,
	);
	expect(result.kind).toBe("applied");
	expect(result.usedRefs).toEqual(["skill:compare@1"]);
	expect(result.disclosed[0]?.sections?.map((s) => s.id)).toEqual(["inspect"]);
	expect(result.modelCalls).toBe(2);
});

test("full body fallback when the source has no section IDs", () => {
	const view = evidenceCardView(evidence[1]!);
	expect(view.hasSections).toBe(false);
	const disclosed = discloseEvidence(evidence, [{ ref: "doc:plain@1" }]);
	expect(disclosed[0]?.body).toBe("section ID のない本文。");
	expect(disclosed[0]?.sections).toBeUndefined();
});

test("baseline skip leaves synthesis out of the path", async () => {
	const result = await runAgentSkillsBaseline(
		{
			inference: {
				complete: async () => ({
					value: { kind: "skip", reason: "候補が合わない" },
					inputTokens: 1,
					outputTokens: 1,
				}),
			},
			now: () => 1,
		},
		{
			task: { goal: "別件", acceptance: [{ id: "a", text: "完了" }] },
			cards: [],
			evidence: [],
			requestRef: "eval:2",
			maxModelCalls: 1,
		},
		new AbortController().signal,
	);
	expect(result.kind).toBe("skipped");
	expect(result.usedRefs).toEqual([]);
});
