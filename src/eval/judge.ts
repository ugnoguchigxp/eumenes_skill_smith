import { z } from "zod";

const id = z.string().min(1).max(160);

/** Human label used to calibrate an LLM judge (ARES-inspired). No accuracy is invented here. */
export const humanLabelSchema = z.strictObject({
	taskId: id,
	condition: z.enum(["none", "agent_skills", "skillsmith"]),
	acceptanceMet: z.boolean(),
	misApplied: z.boolean(),
	needsInputAppropriate: z.boolean().optional(),
});
export type HumanLabel = z.infer<typeof humanLabelSchema>;

export const judgePredictionSchema = z.strictObject({
	taskId: id,
	condition: z.enum(["none", "agent_skills", "skillsmith"]),
	acceptanceMet: z.boolean(),
	misApplied: z.boolean(),
	needsInputAppropriate: z.boolean().optional(),
});
export type JudgePrediction = z.infer<typeof judgePredictionSchema>;

export const calibrationReportSchema = z.strictObject({
	labeled: z.number().int().nonnegative(),
	compared: z.number().int().nonnegative(),
	acceptanceAgree: z.number().int().nonnegative(),
	misAppliedAgree: z.number().int().nonnegative(),
	/** agree/compared when compared>0; otherwise null — never a fake score. */
	acceptanceAgreementRate: z.number().min(0).max(1).nullable(),
	misAppliedAgreementRate: z.number().min(0).max(1).nullable(),
});
export type CalibrationReport = z.infer<typeof calibrationReportSchema>;

/** Apply human labels against judge predictions. Does not invent accuracy thresholds. */
export function calibrateJudge(
	labels: HumanLabel[],
	predictions: JudgePrediction[],
): CalibrationReport {
	const parsedLabels = labels.map((l) => humanLabelSchema.parse(l));
	const byKey = new Map(
		predictions.map((p) => {
			const parsed = judgePredictionSchema.parse(p);
			return [`${parsed.taskId}::${parsed.condition}`, parsed] as const;
		}),
	);
	let compared = 0;
	let acceptanceAgree = 0;
	let misAppliedAgree = 0;
	for (const label of parsedLabels) {
		const pred = byKey.get(`${label.taskId}::${label.condition}`);
		if (!pred) continue;
		compared++;
		if (pred.acceptanceMet === label.acceptanceMet) acceptanceAgree++;
		if (pred.misApplied === label.misApplied) misAppliedAgree++;
	}
	return calibrationReportSchema.parse({
		labeled: parsedLabels.length,
		compared,
		acceptanceAgree,
		misAppliedAgree,
		acceptanceAgreementRate: compared ? acceptanceAgree / compared : null,
		misAppliedAgreementRate: compared ? misAppliedAgree / compared : null,
	});
}
