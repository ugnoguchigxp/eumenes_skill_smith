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
