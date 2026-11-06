import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";

test("untrustedEvidence is datamarked with a spotlight boundary", async () => {
	const f = fixture();
	const turns = [
		{
			kind: "disclose",
			items: [{ ref: "skill:compare@1", sectionIds: ["inspect"] }],
		},
		{
			kind: "ready",
			strategy: "reuse",
			sourceRefs: ["skill:compare@1"],
			sections: [],
			patches: [],
			requiredCapabilities: ["read"],
			verification: ["確認する"],
			assumptions: [],
		},
	];
	let i = 0;
	let second: unknown;
	f.ports.inference.complete = async (input) => {
		if (i === 1) second = structuredClone(input.data);
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
	const ue = (
		second as {
			untrustedEvidence: { boundary: string; items: { datamark: string }[] };
		}
	).untrustedEvidence;
	expect(ue.boundary).toContain("UNTRUSTED_EVIDENCE");
	expect(ue.items[0]!.datamark).toBe("<<UNTRUSTED>>");
});

test("freshness exposes retrievedAt and superseded signals", async () => {
	const f = fixture();
	let first: unknown;
	const original = f.ports.inference.complete;
	f.ports.inference.complete = async (input, signal) => {
		first ??= structuredClone(input.data);
		return original(input, signal);
	};
	await ready(f);
	const freshness = (
		first as {
			freshness: {
				ref: string;
				retrievedAt: number | null;
				status: string;
			}[];
		}
	).freshness;
	expect(freshness[0]!.ref).toBe("skill:compare@1");
	expect(freshness[0]!.retrievedAt).toBeGreaterThan(0);
	expect(freshness[0]!.status).toBe("active");
});
