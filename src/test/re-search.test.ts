import { expect, test } from "bun:test";
import { fixture } from "./fixture.js";

test("model can request one budgeted re_search without keyword gating", async () => {
	const f = fixture({ external: true });
	const searches: string[] = [];
	const original = f.ports.source!.search;
	f.ports.source!.search = async (query, limit, signal) => {
		searches.push(query);
		if (searches.length === 1) {
			return {
				cards: [],
				warnings: [],
				degraded: ["vector_unavailable"],
				truncated: true,
			};
		}
		return original(query, limit, signal);
	};
	// Prefer local reuse after re-search so settle does not depend on external validate envelope size.
	const turns = [
		{ kind: "re_search", query: "資料 比較 手順" },
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
	f.request.limits.sourceCalls = 16;
	const pending = f.submit();
	const work = await f.run(pending.requestRef!);
	expect(work.result.decision.kind).toBe("ready");
	expect(work.settle()).toBe(true);
	const got = f.service.get(f.db, pending.requestRef!, f.auth);
	expect(got.kind).toBe("ready");
	expect(searches.length).toBe(2);
	// External SourcePort keeps TrustedContext.searchTask; model query is local-only.
	expect(searches[0]).toBe(f.auth.searchTask);
	expect(searches[1]).toBe(f.auth.searchTask);
	const re = (
		seen[1] as {
			search: {
				reSearch: {
					query: string;
					externalQuery: string | null;
					cardsAdded: number;
				}[];
			};
		}
	).search.reSearch;
	expect(re).toHaveLength(1);
	expect(re[0]!.query).toBe("資料 比較 手順");
	expect(re[0]!.externalQuery).toBe(f.auth.searchTask!);
	expect(re[0]!.cardsAdded).toBeGreaterThanOrEqual(0);
	// First model turn saw degraded search data (not keyword-gated by product code).
	expect(
		(seen[0] as { search: { external: { degraded: string[] } } }).search
			.external.degraded,
	).toContain("vector_unavailable");
});

test("a second re_search is refused within the same build", async () => {
	const f = fixture({ external: true });
	const turns = [
		{ kind: "re_search", query: "一度目" },
		{ kind: "re_search", query: "二度目" },
		{
			kind: "needs_input",
			missing: ["再検索上限後の不足"],
		},
	];
	let i = 0;
	f.ports.inference.complete = async () => ({
		value: turns[i++]!,
		receipt: "receipt",
		inputTokens: 1,
		outputTokens: 1,
	});
	f.request.limits.modelCalls = 4;
	f.request.limits.sourceCalls = 16;
	const pending = f.submit();
	const work = await f.run(pending.requestRef!);
	expect(work.result.decision.kind).toBe("needs_input");
	expect(work.settle()).toBe(true);
	expect(f.service.get(f.db, pending.requestRef!, f.auth).kind).toBe(
		"needs_input",
	);
	expect(i).toBe(3);
});
