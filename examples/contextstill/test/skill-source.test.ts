import { seedFixturePath } from "./seed-fixture.js";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { contextStillSourceMarkdown } from "../skill-source.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource } from "../source.js";

const banned = [
	'{"contractVersion',
	"_fixture",
	"trustClass",
	'"trust"',
	"fixtureLimitations",
	"digest",
];

test("ContextStill envelope renders only usable fields as Markdown", async () => {
	const fixture = new ContextStillFixture(resolve(seedFixturePath()), "handle");
	const token = crypto.randomUUID();
	try {
		const source = createFixtureSource(createMcpHandler(fixture, token), token);
		const doc = await source.get(
			"contextstill:kn_4eev36krjgtot3bopqmb6rhjtu",
			new AbortController().signal,
		);
		expect(doc.body).toContain('{"contractVersion');
		const md = contextStillSourceMarkdown(doc.body);
		expect(md).toContain("Write Go in a way that matches Go's own idioms");
		for (const s of banned) expect(md).not.toContain(s);
		expect(md).not.toContain("2026-05-31");
	} finally {
		fixture.close();
	}
});

test("all non-empty knowledge fields render deterministically; others pass through", () => {
	const body = JSON.stringify({
		contractVersion: "contextstill-knowledge.v1",
		trust: {
			trustClass: "untrusted_knowledge_evidence",
			instructionAuthority: "none",
		},
		item: {
			handle: "kn_x",
			confidence: 0.9,
			createdAt: "2026-01-01T00:00:00Z",
			body: "Main rule.",
			rationale: "Because.",
			steps: ["One", "Two"],
			appliesWhen: ["When A"],
			notAppliesWhen: ["When B"],
			exceptions: ["Except C"],
			examples: [{ situation: "S", action: "A", outcome: "O", episodes: [] }],
		},
		_fixture: { digest: "abc" },
	});
	const md = contextStillSourceMarkdown(body);
	expect(md).toBe(
		"Main rule.\n\n### 理由\n\nBecause.\n\n### 手順\n\n1. One\n2. Two\n\n### 適用する場面\n\n- When A\n\n### 適用しない場面\n\n- When B\n\n### 例外\n\n- Except C\n\n### 例\n\n- 状況: S。行動: A。結果: O",
	);
	expect(contextStillSourceMarkdown(body)).toBe(md);
	expect(contextStillSourceMarkdown("plain text")).toBe("plain text");
});
