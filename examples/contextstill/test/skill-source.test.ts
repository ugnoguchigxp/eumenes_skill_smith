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
	const fixture = new ContextStillFixture(
		resolve("data/contextstill/seed.sqlite"),
		"handle",
	);
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
		"Main rule.\n\n### Rationale\n\nBecause.\n\n### Steps\n\n1. One\n2. Two\n\n### Applies when\n\n- When A\n\n### Does not apply when\n\n- When B\n\n### Exceptions\n\n- Except C\n\n### Examples\n\n- Situation: S; Action: A; Outcome: O",
	);
	expect(contextStillSourceMarkdown(body)).toBe(md);
	expect(contextStillSourceMarkdown("plain text")).toBe("plain text");
});
