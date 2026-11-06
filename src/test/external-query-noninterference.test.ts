import { expect, test } from "bun:test";
import { fixture } from "./fixture.js";

const answer = (value: unknown) => ({
	value,
	receipt: "receipt",
	inputTokens: 1,
	outputTokens: 1,
});

test("re_search model query does not reach external SourcePort", async () => {
	const f = fixture({ external: true });
	const externalQueries: string[] = [];
	const localQueries: string[] = [];
	const originalExternal = f.ports.source!.search;
	const originalLocal = f.ports.registry.search;
	f.ports.source!.search = async (query, limit, signal) => {
		externalQueries.push(query);
		return originalExternal(query, limit, signal);
	};
	f.ports.registry.search = async (query, authority, limit, signal) => {
		localQueries.push(query);
		return originalLocal(query, authority, limit, signal);
	};
	let n = 0;
	f.ports.inference.complete = async () =>
		answer(
			n++ === 0
				? { kind: "re_search", query: "PRIVATE_CANARY_42" }
				: { kind: "unavailable", code: "end" },
		);
	f.request.limits.modelCalls = 3;
	f.request.limits.sourceCalls = 16;
	const pending = f.submit();
	await f.run(pending.requestRef!);
	expect(externalQueries).toEqual([f.auth.searchTask!, f.auth.searchTask!]);
	expect(externalQueries.every((q) => !q.includes("PRIVATE_CANARY_42"))).toBe(
		true,
	);
	expect(localQueries[1]).toBe("PRIVATE_CANARY_42");
});

test("changing private goal canary does not change external re_search payload", async () => {
	async function runWithGoal(goal: string) {
		const f = fixture({ external: true });
		f.request.task.goal = goal;
		const externalQueries: string[] = [];
		const payloads: unknown[] = [];
		const original = f.ports.source!.search;
		f.ports.source!.search = async (query, limit, signal) => {
			externalQueries.push(query);
			payloads.push({ query, limit });
			return original(query, limit, signal);
		};
		let n = 0;
		f.ports.inference.complete = async () =>
			answer(
				n++ === 0
					? { kind: "re_search", query: `leak:${goal}` }
					: { kind: "unavailable", code: "end" },
			);
		f.request.limits.modelCalls = 3;
		f.request.limits.sourceCalls = 16;
		const pending = f.submit();
		await f.run(pending.requestRef!);
		return { externalQueries, payloads, searchTask: f.auth.searchTask! };
	}
	const a = await runWithGoal("PRIVATE_CANARY_A");
	const b = await runWithGoal("PRIVATE_CANARY_B");
	expect(a.searchTask).toBe(b.searchTask);
	expect(a.externalQueries).toEqual(b.externalQueries);
	expect(a.payloads).toEqual(b.payloads);
	expect(JSON.stringify(a.externalQueries)).not.toContain("PRIVATE_CANARY");
	expect(JSON.stringify(b.externalQueries)).not.toContain("PRIVATE_CANARY");
});

test("without searchTask, re_search stays local-only", async () => {
	const f = fixture();
	delete (f.auth as { searchTask?: string }).searchTask;
	const localQueries: string[] = [];
	const originalLocal = f.ports.registry.search;
	f.ports.registry.search = async (query, authority, limit, signal) => {
		localQueries.push(query);
		return originalLocal(query, authority, limit, signal);
	};
	// No SourcePort: externalUsed stays false.
	f.ports.source = undefined;
	let n = 0;
	const seen: unknown[] = [];
	f.ports.inference.complete = async (input) => {
		seen.push(structuredClone(input.data));
		return answer(
			n++ === 0
				? { kind: "re_search", query: "local-only-query" }
				: { kind: "unavailable", code: "end" },
		);
	};
	f.request.limits.modelCalls = 3;
	const pending = f.submit();
	await f.run(pending.requestRef!);
	expect(localQueries[1]).toBe("local-only-query");
	const re = (
		seen[1] as {
			search: {
				reSearch: { query: string; externalQuery: string | null }[];
			};
		}
	).search.reSearch;
	expect(re[0]!.query).toBe("local-only-query");
	expect(re[0]!.externalQuery).toBeNull();
});
