import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";

test("first model input carries evidenceIndex without bodies", async () => {
	const f = fixture();
	let first: unknown;
	const original = f.ports.inference.complete;
	f.ports.inference.complete = async (input, signal) => {
		first ??= structuredClone(input.data);
		return original(input, signal);
	};
	await ready(f);
	const data = first as {
		evidenceIndex: {
			ref: string;
			sectionIds: string[];
			hasSections: boolean;
		}[];
		untrustedEvidence: { items: unknown[] };
	};
	expect(data.evidenceIndex[0]!.ref).toBe("skill:compare@1");
	expect(data.evidenceIndex[0]!.sectionIds).toEqual(["inspect", "compare"]);
	expect(data.evidenceIndex[0]!.hasSections).toBe(true);
	expect(data.untrustedEvidence.items).toEqual([]);
	expect(JSON.stringify(data.evidenceIndex)).not.toContain(
		"資料の正本を確認し",
	);
});

test("disclose adds requested sections; full body when no section IDs", async () => {
	const f = fixture();
	f.setEvidence([
		{
			ref: "skill:compare@1",
			version: { id: "compare", version: "1", digest: "digest", generation: 0 },
			title: "比較",
			body: "全文",
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
			body: "sectionのない本文",
			status: "active",
			complete: true,
			external: false,
			scope: "shared",
		},
	]);
	const turns = [
		{
			kind: "disclose",
			items: [
				{ ref: "skill:compare@1", sectionIds: ["inspect"] },
				{ ref: "doc:plain@1" },
			],
		},
		{
			kind: "ready",
			strategy: "compose",
			sourceRefs: ["skill:compare@1"],
			sections: [
				{ id: "start", body: "確認する。" },
				{ id: "finish", body: "報告する。" },
			],
			patches: [],
			requiredCapabilities: ["read"],
			verification: ["確認する"],
			assumptions: [],
		},
	];
	let i = 0;
	const seen: unknown[] = [];
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
	expect(work.result.decision.kind).toBe("ready");
	expect(work.settle()).toBe(true);
	expect(
		(seen[0] as { untrustedEvidence: { items: unknown[] } }).untrustedEvidence
			.items,
	).toEqual([]);
	const disclosed = (
		seen[1] as {
			untrustedEvidence: {
				items: {
					ref: string;
					sections?: { id: string; body: string }[];
					body?: string;
					datamark?: string;
					untrusted?: boolean;
					title: string;
					status: string;
				}[];
			};
		}
	).untrustedEvidence.items;
	expect(disclosed).toHaveLength(2);
	expect(disclosed[0]!.ref).toBe("skill:compare@1");
	expect(disclosed[0]!.sections?.map((s) => s.id)).toEqual(["inspect"]);
	expect(disclosed[0]!.datamark).toBe("<<UNTRUSTED>>");
	expect(disclosed[1]!.ref).toBe("doc:plain@1");
	expect(disclosed[1]!.body).toBe("sectionのない本文");
});
