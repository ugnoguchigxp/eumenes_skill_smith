import { expect, test } from "bun:test";
import { fixture } from "./fixture.js";

const answer = (value: unknown) => ({
	value,
	receipt: "receipt",
	inputTokens: 1,
	outputTokens: 1,
});

const card = (ref: string) => ({
	ref,
	version: { id: ref, version: "1", digest: "d", generation: 0 },
	title: ref,
	status: "active" as const,
	complete: true,
	external: false,
	scope: "shared",
});

test("re-search admits a new card when the initial working set is full", async () => {
	const f = fixture();
	f.request.limits.candidates = 1;
	f.request.limits.documents = 1;
	f.request.limits.modelCalls = 3;
	f.request.limits.sourceCalls = 16;
	let n = 0;
	const seen: any[] = [];
	f.ports.registry.search = async () => [card(n++ === 0 ? "old" : "new")];
	f.ports.registry.read = async (ref) => ({ ...card(ref), body: ref });
	f.ports.inference.complete = async (input) => {
		seen.push(structuredClone(input.data));
		return answer(
			seen.length === 1
				? { kind: "re_search", query: "new" }
				: { kind: "unavailable", code: "end" },
		);
	};
	const pending = f.submit();
	await f.run(pending.requestRef!);
	expect(seen[1].candidateCards.map((c: any) => c.ref)).toEqual(["new"]);
	expect(seen[1].evidenceIndex.map((c: any) => c.ref)).toEqual(["new"]);
	expect(seen[1].search.reSearch[0].cardsAdded).toBe(1);
	expect(seen[1].search.reSearch[0].cardsAdmitted).toBe(1);
	expect(seen[1].search.reSearch[0].documentsFetched).toBe(1);
});

test("re-search keeps first-round warnings for a retained external card", async () => {
	const f = fixture({ external: true });
	let searches = 0;
	const seen: any[] = [];
	const original = f.ports.source!.search;
	f.ports.source!.search = async (q, l, s) => {
		const result = await original(q, l, s);
		return searches++ === 0
			? {
					...result,
					warnings: [{ kind: "conflict", refs: ["external:1"] }],
					degraded: ["index_cold"],
				}
			: { cards: [], warnings: [], degraded: [], truncated: false };
	};
	f.request.limits.sourceCalls = 16;
	f.request.limits.modelCalls = 3;
	f.ports.inference.complete = async (input) => {
		seen.push(structuredClone(input.data));
		return answer(
			seen.length === 1
				? { kind: "re_search", query: "again" }
				: { kind: "unavailable", code: "end" },
		);
	};
	const pending = f.submit();
	await f.run(pending.requestRef!);
	expect(seen[1].evidenceIndex.some((c: any) => c.ref === "external:1")).toBe(
		true,
	);
	expect(seen[1].search.external.warnings).toEqual([
		{ kind: "conflict", refs: ["external:1"] },
	]);
	expect(seen[1].search.external.degraded).toContain("index_cold");
});
