import { artifactDigest } from "../../../src/service/identity.js";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeSkillArtifact } from "../skill-output.js";
import { runFull } from "../scenario-runner.js";
import { recordedInference } from "../recorded.js";
import { validateSkillMarkdown } from "../../../src/index.js";
import { parseAnyScenarioSuite as parseSuite } from "../../../src/eval/scenario-score.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource } from "../source.js";

// Recorded inference only: verify emission before judge completion, with no fresh model calls.
test("full runner emits validated build files per task even while judge replay is pending", async () => {
	const dir = mkdtempSync(resolve(tmpdir(), "skill-output-"));
	const fixture = new ContextStillFixture(
		resolve("data/contextstill/seed.sqlite"),
		"handle",
	);
	const token = crypto.randomUUID();
	const load = (name: string) =>
		JSON.parse(
			readFileSync(resolve("examples/contextstill/scenarios", name), "utf8"),
		);
	const records = load("build-records-absent-baseline.json");
	const tasks = parseSuite(load("suite-3axis.json")).tasks.filter(
		(t) => t.id === "qiskit-noise",
	);
	const files: string[] = [];
	try {
		const result = await runFull({
			assemblyMode: "legacy",
			tasks,
			source: createFixtureSource(createMcpHandler(fixture, token), token),
			createInference: (role, onTask) =>
				recordedInference(role === "build" ? records : [], onTask, undefined, {
					namespace: "legacy",
				}),
			hasBuildRecord: (d) =>
				records.some((r: { inputDigest: string }) => r.inputDigest === d),
			onSkill: (id, skill) => {
				expect(id).toBe("qiskit-noise");
				files.push(
					writeSkillArtifact(
						resolve(dir, `task-${encodeURIComponent(id)}`),
						skill,
					),
				);
			},
		});
		expect(result.complete).toBe(false);
		expect(result.pendingJudge).toHaveLength(1);
		expect(files).toHaveLength(1);
		const text = readFileSync(files[0]!, "utf8");
		expect(text).toContain("暫定・未検証");
		for (const s of ['{"contractVersion', "_fixture", "trustClass"])
			expect(text).not.toContain(s);
		expect(text).toContain("## 手順\n");
		expect(() => validateSkillMarkdown(text)).not.toThrow();
	} finally {
		fixture.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("file writer rejects traversal, mismatched names and empty bodies before writing", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "skill-output-"));
	const content =
		'---\nname: "safe-name"\ndescription: "Does checks. Use for checks."\n---\nInstructions.';
	try {
		expect(() =>
			writeSkillArtifact(dir, {
				digest: artifactDigest(content),
				rendererVersion: "synthetic",
				sourceExtractorVersion: "none",
				name: "safe-name",
				path: "../../SKILL.md",
				content,
			}),
		).toThrow("skill_path_invalid");
		expect(() =>
			writeSkillArtifact(dir, {
				digest: artifactDigest(content),
				rendererVersion: "synthetic",
				sourceExtractorVersion: "none",
				name: "other-name",
				path: "other-name/SKILL.md",
				content,
			}),
		).toThrow("skill_directory_mismatch");
		expect(() =>
			writeSkillArtifact(dir, {
				digest: artifactDigest(content),
				rendererVersion: "synthetic",
				sourceExtractorVersion: "none",
				name: "safe-name",
				path: "safe-name/SKILL.md",
				content: content.replace("Instructions.", ""),
			}),
		).toThrow("skill_body_empty");
		const path = writeSkillArtifact(dir, {
			digest: artifactDigest(content),
			rendererVersion: "synthetic",
			sourceExtractorVersion: "none",
			name: "safe-name",
			path: "safe-name/SKILL.md",
			content,
		});
		expect(readFileSync(path, "utf8")).toBe(content);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scenario CLI writes and reports SKILL.md paths under the requested output directory", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "skill-cli-"));
	try {
		const result = Bun.spawnSync(
			[
				process.execPath,
				"examples/contextstill/scenario-eval.ts",
				"--assembly-mode",
				"legacy",
				"--suite",
				"examples/contextstill/scenarios/suite-3axis.json",
				"--axis",
				"absent",
				"--search-profile",
				"handle",
				"--query-reformulation",
				"off",
				"--build-records",
				"examples/contextstill/scenarios/build-records-absent-baseline.json",
				"--judge-records",
				"examples/contextstill/scenarios/judge-records-absent-baseline.json",
				"--output-dir",
				dir,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout.toString()) as {
			skillFiles: { taskId: string; path: string }[];
			ok: boolean;
		};
		expect(report.ok).toBe(true);
		expect(report.skillFiles).toHaveLength(4);
		for (const file of report.skillFiles) {
			expect(
				file.path.startsWith(
					resolve(dir, "skills", `task-${encodeURIComponent(file.taskId)}`) +
						"/",
				),
			).toBe(true);
			expect(file.path.endsWith("/SKILL.md")).toBe(true);
			const text = readFileSync(file.path, "utf8");
			expect(() => validateSkillMarkdown(text)).not.toThrow();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
