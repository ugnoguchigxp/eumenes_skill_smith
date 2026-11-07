import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

for (const companion of [
	"missing",
	"valid",
	"malformed",
	"null",
	"array",
	"wrong-value",
	"directory",
	"mismatch",
] as const) {
	test(`eval CLI ${companion} expected-digest manifest has explicit fail-closed behavior`, () => {
		const dir = mkdtempSync(resolve(tmpdir(), "eval-digests-"));
		try {
			const suite = resolve(dir, "suite.json");
			const manifest = resolve(dir, "suite.expected-digests.json");
			const conditions = ["none", "agent_skills", "skillsmith"];
			writeFileSync(
				suite,
				JSON.stringify({
					id: "synthetic",
					tasks: [
						{
							id: "t",
							goal: "確認する",
							acceptance: [{ id: "a", text: "比較する" }],
						},
					],
					records: conditions.map((condition) => ({
						taskId: "t",
						condition,
						records: [
							{
								inputDigest: `digest-${condition}`,
								provider: "fixture",
								value: { kind: "ready" },
							},
						],
					})),
				}),
			);
			if (companion === "valid")
				writeFileSync(
					manifest,
					JSON.stringify(
						Object.fromEntries(
							conditions.map((c) => [`t:${c}`, `digest-${c}`]),
						),
					),
				);
			if (companion === "malformed") writeFileSync(manifest, "{broken");
			if (companion === "null") writeFileSync(manifest, "null");
			if (companion === "array") writeFileSync(manifest, "[]");
			if (companion === "wrong-value") writeFileSync(manifest, '{"t:none":17}');
			if (companion === "directory") mkdirSync(manifest);
			if (companion === "mismatch")
				writeFileSync(manifest, '{"t:none":"wrong-digest"}');
			const result = Bun.spawnSync(
				[process.execPath, "examples/contextstill/eval-kit.ts", suite],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if (companion === "missing" || companion === "valid") {
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.stdout.toString()).audit.ok).toBe(true);
			} else {
				expect(result.exitCode).not.toBe(0);
				expect(result.stdout.toString()).toBe("");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
test("non-json suite names use a separate expected-digest companion", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "eval-extension-"));
	try {
		const suite = resolve(dir, "suite.input");
		writeFileSync(
			suite,
			JSON.stringify({
				id: "synthetic",
				tasks: [
					{
						id: "t",
						goal: "確認する",
						acceptance: [{ id: "a", text: "比較する" }],
					},
				],
				records: ["none", "agent_skills", "skillsmith"].map((condition) => ({
					taskId: "t",
					condition,
					records: [],
				})),
			}),
		);
		writeFileSync(suite + ".expected-digests.json", "{broken");
		const result = Bun.spawnSync(
			[process.execPath, "examples/contextstill/eval-kit.ts", suite],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toBe("");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
