import type { InferenceTask } from "./recorded.js";

/** Structural evaluation boundary, not a semantic content classifier. */
const hostOnly = new Set([
	"expectedRefs",
	"expectedTitles",
	"nearestFalseFriendRefs",
	"axis",
	"untrustedJudgeData",
	"gold",
	"scores",
]);
function assertBuilderData(value: unknown): void {
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (hostOnly.has(key)) throw new Error("builder_packet_host_label:" + key);
		assertBuilderData(child);
	}
}
export type PendingBuilderRow = { taskId: string; tasks: InferenceTask[] };
/** Never accept a host suite/report or judge records here; only provider-facing pending turns. */
export function builderPackets(
	build: PendingBuilderRow[],
	reformulation: PendingBuilderRow[] = [],
) {
	return (
		[
			["build", build],
			["reformulation", reformulation],
		] as const
	).flatMap(([role, rows]) =>
		rows.flatMap((row) =>
			row.tasks.map((task) => {
				assertBuilderData(task.data);
				// A closed projection prevents arbitrary host row/turn extensions from crossing the boundary.
				const input = {
					namespace: task.namespace,
					semanticInputId: task.semanticInputId,
					executionConditionId: task.executionConditionId,
					providerSettings: task.providerSettings,
					inputDigest: task.inputDigest,
					requestRef: task.requestRef,
					system: task.system,
					data: structuredClone(task.data),
					schema: structuredClone(task.schema),
					maxOutputTokens: task.maxOutputTokens,
					deadlineAt: task.deadlineAt,
				};
				return { taskId: row.taskId, role, input };
			}),
		),
	);
}

/** Evaluation may shrink document admission, never enlarge the product cap. */
export function parseDocumentLimit(argv: string[]): number {
	const index = argv.indexOf("--documents");
	if (index < 0) return 8;
	const value = argv[index + 1];
	if (!value || !/^[1-8]$/.test(value))
		throw new Error("invalid_document_limit");
	return Number(value);
}
