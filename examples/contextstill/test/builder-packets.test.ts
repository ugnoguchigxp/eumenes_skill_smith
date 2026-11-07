import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, expect } from "bun:test";
import { builderPackets, parseDocumentLimit } from "../builder-packets.js";
import { inferenceTask } from "../recorded.js";
const turn = inferenceTask({
	system: "build",
	data: { task: { goal: "synthetic" } },
	schema: { type: "object" },
	requestRef: "r",
	maxOutputTokens: 20,
	deadlineAt: 100,
});
test("builder-only packet projects provider turns, not surrounding gold or host suite", () => {
	const rows = [
		{
			taskId: "t",
			tasks: [{ ...turn, expectedRefs: ["HOST_ONLY"] }],
			expectedRefs: ["HOST_ONLY"],
		},
	];
	const packet = builderPackets(rows);
	expect(JSON.stringify(packet)).not.toContain("HOST_ONLY");
	expect(packet[0]!.input.inputDigest).toBe(turn.inputDigest);
	expect(packet[0]!.role).toBe("build");
});
test("builder-only boundary rejects nested host labels and judge inputs instead of stripping silently", () => {
	for (const data of [
		{ task: { expectedRefs: ["secret"] } },
		{ untrustedJudgeData: { data: {} } },
	]) {
		expect(() =>
			builderPackets([{ taskId: "t", tasks: [{ ...turn, data }] }]),
		).toThrow("builder_packet_host_label");
	}
});

test("evaluation document admission can only shrink the existing eight-document limit", () => {
	expect(parseDocumentLimit([])).toBe(8);
	expect(parseDocumentLimit(["--documents", "4"])).toBe(4);
	for (const value of ["0", "9", "4.5", "no", ""])
		expect(() => parseDocumentLimit(["--documents", value])).toThrow(
			"invalid_document_limit",
		);
});

for (const key of [
	"expectedTitle",
	"untrustedQualityData",
	"searchPreview",
	"allRequiredHitAt8",
	"allRequiredHitAt20Diagnostic",
	"retrievalRank",
	"ranks",
	"meanScore",
	"qualityScores",
]) {
	test(`packet rejects nested host-only metric ${key}`, () => {
		expect(() =>
			builderPackets([
				{
					taskId: "t",
					tasks: [{ ...turn, data: { task: { [key]: "HOST_CANARY" } } }],
				},
			]),
		).toThrow("builder_packet_host_label");
	});
}
test("builder packet data rejects unknown top-level fields and invalid role data", () => {
	for (const data of [
		{ task: {}, surprise: "HOST_CANARY" },
		{ originalTask: {}, unexpected: true },
	])
		expect(() =>
			builderPackets([{ taskId: "t", tasks: [{ ...turn, data }] }]),
		).toThrow("builder_packet_data_key");
	expect(() => builderPackets([], [{ taskId: "t", tasks: [turn] }])).toThrow(
		"builder_packet_data_key",
	);
	expect(() =>
		builderPackets([{ taskId: "t", tasks: [{ ...turn, data: null }] }]),
	).toThrow("builder_packet_data_invalid");
});
test("boundary leaves ordinary prose intact and admits semantic-review and reformulation packets", () => {
	const data = {
		task: { goal: "gold and retrievalRank are ordinary quoted evidence here" },
	};
	expect(
		builderPackets([{ taskId: "t", tasks: [{ ...turn, data }] }])[0]?.input
			.data,
	).toEqual(data);
	expect(
		builderPackets([
			{
				taskId: "t",
				tasks: [
					{
						...turn,
						data: { originalTask: {}, reviewPlan: [], untrustedReview: [] },
					},
				],
			},
		]),
	).toHaveLength(1);
	expect(
		builderPackets(
			[],
			[
				{
					taskId: "t",
					tasks: [{ ...turn, data: { searchTask: "public query" } }],
				},
			],
		)[0]?.role,
	).toBe("reformulation");
});

for (const reformulation of ["off", "on"]) {
	test(`builder-only CLI excludes host metrics/gold and unread judge records (${reformulation})`, () => {
		const dir = mkdtempSync(resolve(tmpdir(), "builder-cli-"));
		try {
			const suite = resolve(dir, "suite.json");
			const judge = resolve(dir, "judge.json");
			const build = resolve(dir, "build.json");
			const auxiliary = resolve(dir, "auxiliary.json");
			const output = resolve(dir, "output");
			writeFileSync(
				suite,
				JSON.stringify({
					id: "synthetic-blind",
					tasks: [
						{
							id: "synthetic",
							goal: "公開資料を比較する",
							acceptance: [{ id: "checked", text: "相違を確かめる" }],
							expectedRefs: ["HOST_GOLD_CANARY"],
							expectedTitle: "HOST_TITLE_CANARY",
						},
					],
				}),
			);
			writeFileSync(
				judge,
				"deliberately not JSON: must never be read in builder mode",
			);
			writeFileSync(build, "[]");
			writeFileSync(auxiliary, "[]");
			const args = [
				process.execPath,
				"examples/contextstill/scenario-eval.ts",
				"--builder-only",
				"--suite",
				suite,
				"--output-dir",
				output,
				"--query-reformulation",
				reformulation,
				"--reformulation-records",
				auxiliary,
				"--build-records",
				build,
				"--judge-records",
				judge,
			];
			const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
			expect(result.stderr.toString()).toBe("");
			expect(result.exitCode).toBe(2);
			const stdout = result.stdout.toString();
			const packets = JSON.parse(stdout);
			expect(Array.isArray(packets)).toBe(true);
			expect(packets).toHaveLength(1);
			expect(packets[0].role).toBe(
				reformulation === "on" ? "reformulation" : "build",
			);
			expect(stdout).not.toContain("HOST_GOLD_CANARY");
			expect(stdout).not.toContain("HOST_TITLE_CANARY");
			expect(Object.keys(packets[0]).sort()).toEqual([
				"input",
				"role",
				"taskId",
			]);
			expect(
				readFileSync(resolve(output, "builder-packets.json"), "utf8"),
			).toBe(stdout.trimEnd());
			expect(readdirSync(output).sort()).toEqual(["builder-packets.json"]);
			if (reformulation === "off") {
				// Fixed wiring-only outcome: no semantic answer is manufactured by this test.
				writeFileSync(
					build,
					JSON.stringify([
						{
							inputDigest: packets[0].input.inputDigest,
							value: { kind: "unavailable", code: "synthetic_no_answer" },
							provider: "fixture",
						},
					]),
				);
				const terminal = Bun.spawnSync(args, {
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(terminal.exitCode).toBe(0);
				expect(JSON.parse(terminal.stdout.toString())).toEqual([]);
				expect(readdirSync(output).sort()).toEqual(["builder-packets.json"]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
test("builder-only CLI rejects incompatible evaluation modes before opening files", () => {
	for (const flags of [
		["--retrieval-only"],
		["--evidence-supply", "oracle"],
		["--abstention-contrast", "on"],
	]) {
		const result = Bun.spawnSync(
			[
				process.execPath,
				"examples/contextstill/scenario-eval.ts",
				"--builder-only",
				...flags,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain(
			"builder-only requires full natural evaluation",
		);
	}
});
