import { z } from "zod";

const id = z.string().min(1).max(160);

export const recallLabelSchema = z.strictObject({
	taskId: id,
	/** Refs a correct retrieval should include (human-labeled). */
	expectedRefs: z.array(id).min(1).max(32),
});
export type RecallLabel = z.infer<typeof recallLabelSchema>;

export const recallObservationSchema = z.strictObject({
	taskId: id,
	/** Ordered cards as returned by search (top first). */
	retrievedRefs: z.array(id).max(100),
	k: z.number().int().positive().max(100),
});
export type RecallObservation = z.infer<typeof recallObservationSchema>;

export const recallResultSchema = z.strictObject({
	taskId: id,
	k: z.number().int().positive(),
	expected: z.array(id),
	hit: z.array(id),
	missed: z.array(id),
	/** |hit| / |expected| at cutoff k. */
	recallAtK: z.number().min(0).max(1),
});
export type RecallResult = z.infer<typeof recallResultSchema>;

/** Compute retrieval recall@k from labeled expected refs and ordered search cards. No meaning heuristics. */
export function recallAtK(
	label: RecallLabel,
	observation: RecallObservation,
): RecallResult {
	const expected = recallLabelSchema.parse(label).expectedRefs;
	const obs = recallObservationSchema.parse(observation);
	if (label.taskId !== obs.taskId) throw new Error("recall_task_mismatch");
	const top = obs.retrievedRefs.slice(0, obs.k);
	const topSet = new Set(top);
	const hit = expected.filter((ref) => topSet.has(ref));
	const missed = expected.filter((ref) => !topSet.has(ref));
	return recallResultSchema.parse({
		taskId: label.taskId,
		k: obs.k,
		expected,
		hit,
		missed,
		recallAtK: expected.length ? hit.length / expected.length : 0,
	});
}

export function meanRecallAtK(results: RecallResult[]): number | null {
	if (!results.length) return null;
	return results.reduce((s, r) => s + r.recallAtK, 0) / results.length;
}
