import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { ContextStillFixture } from "../database.js";
import { seedFixturePath } from "./seed-fixture.js";
import { createFixtureSource } from "../source.js";
import { createMcpHandler } from "../mcp.js";
import { createReformulatingSource } from "../query-reformulation.js";
import { createExampleHost } from "../host.js";
import type { GuidanceRequest } from "../../../src/index.js";
import { sqliteRepository } from "../../../src/sqlite/index.js";

const fixtures = JSON.parse(
	readFileSync(
		new URL("fixtures/generation-budget.json", import.meta.url),
		"utf8",
	),
) as {
	cases: {
		id: string;
		goal: string;
		acceptance: GuidanceRequest["task"]["acceptance"];
		constraints: GuidanceRequest["task"]["constraints"];
		query: string;
		turns: unknown[];
	}[];
};

for (const scenario of fixtures.cases)
	for (const variant of [
		"normal",
		"late-card",
		"version-change",
		"revoked",
	] as const) {
		test(
			"selected external documents complete all source checks within 12 calls: " +
				scenario.id +
				":" +
				variant,
			async () => {
				const fixture = new ContextStillFixture(seedFixturePath(), "bm25");
				const token = crypto.randomUUID();
				const original = createFixtureSource(
					createMcpHandler(fixture, token),
					token,
				);
				const selectedRefs = new Set(
					(scenario.turns[1] as { sourceRefs: string[] }).sourceRefs,
				);
				let validations = 0;
				const plain = {
					...original,
					search: async (...args: Parameters<typeof original.search>) => {
						const found = await original.search(...args);
						return variant === "late-card"
							? {
									...found,
									cards: [
										...found.cards.filter((c) => !selectedRefs.has(c.ref)),
										...found.cards.filter((c) => selectedRefs.has(c.ref)),
									],
								}
							: found;
					},
					get: async (...args: Parameters<typeof original.get>) => {
						const doc = await original.get(...args);
						return variant === "version-change"
							? {
									...doc,
									version: { ...doc.version, digest: "different-version" },
								}
							: doc;
					},
					validate: async (...args: Parameters<typeof original.validate>) => {
						if (variant === "revoked" && ++validations === 2) return false;
						return original.validate(...args);
					},
				};
				const source = createReformulatingSource(
					plain,
					{
						validReceipt: () => true,
						complete: async () => ({
							value: { query: scenario.query },
							receipt: "query-fixture",
							inputTokens: 1,
							outputTokens: 1,
						}),
					},
					{ deadlineAt: 1_700_000_120_000 },
				);
				let turn = 0;
				const host = createExampleHost(
					source,
					scenario.goal,
					{
						validReceipt: () => true,
						complete: async () => ({
							value: structuredClone(scenario.turns[turn++]),
							receipt: "build-fixture",
							inputTokens: 1,
							outputTokens: 1,
						}),
					},
					{
						goal: scenario.goal,
						acceptance: scenario.acceptance,
						constraints: scenario.constraints,
						candidates: 8,
						documents: 8,
						modelCalls: 4,
						outputTokens: 4000,
					},
				);
				try {
					if (variant === "version-change") {
						await expect(host.run()).rejects.toThrow("source_revoked");
						expect(turn).toBe(1);
						expect(
							host.db.query("SELECT count(*) AS n FROM knowledge_builds").get(),
						).toEqual({ n: 0 });
						return;
					}
					const result = await host.run();
					if (variant === "revoked") {
						expect(result).toMatchObject({
							kind: "rejected",
							code: "source_revoked",
						});
						expect(validations).toBe(2);
						return;
					}
					// The old sandbox response also exceeds the final envelope. Keep that guard;
					// this regression proves physical source validation, not current semantic quality.
					expect(result).toMatchObject(
						scenario.id === "sandbox-review"
							? { kind: "unavailable", code: "context_budget_exceeded" }
							: { kind: "ready" },
					);
					expect(
						sqliteRepository.request(host.db, result.requestRef!)!.outcome
							?.kind,
					).toBe("ready");
					expect(turn).toBe(3);
					const sourceCalls = host.callLedger.filter(
						(c) => c.kind === "sourceCalls",
					);
					const selected = (scenario.turns[1] as { sourceRefs: string[] })
						.sourceRefs.length;
					expect(
						sqliteRepository.request(host.db, result.requestRef!)!.usage,
					).toMatchObject({ modelCalls: 4, sourceCalls: 2 + selected * 3 });
					// Read only selected bodies, then physically check each again before commit and delivery.
					expect(
						sourceCalls.filter((c) => c.operation === "get_knowledge"),
					).toHaveLength(selected * 3);
					expect(sourceCalls.every((c) => c.outcome === "ok")).toBe(true);
				} finally {
					host.close();
					fixture.close();
				}
			},
		);
	}
