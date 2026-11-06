import { expect, test } from "bun:test";
import { auxiliaryMetrics, calibrateJudge } from "../eval/index.js";

test("calibrateJudge reports agreement without inventing scores", () => {
	const report = calibrateJudge(
		[
			{
				taskId: "t1",
				condition: "skillsmith",
				acceptanceMet: true,
				misApplied: false,
			},
			{
				taskId: "t2",
				condition: "agent_skills",
				acceptanceMet: false,
				misApplied: true,
			},
		],
		[
			{
				taskId: "t1",
				condition: "skillsmith",
				acceptanceMet: true,
				misApplied: false,
			},
			{
				taskId: "t2",
				condition: "agent_skills",
				acceptanceMet: true,
				misApplied: true,
			},
		],
	);
	expect(report.compared).toBe(2);
	expect(report.acceptanceAgree).toBe(1);
	expect(report.acceptanceAgreementRate).toBe(0.5);
	expect(report.misAppliedAgreementRate).toBe(1);
});

test("calibrateJudge returns null rates when nothing compares", () => {
	const report = calibrateJudge(
		[
			{
				taskId: "t1",
				condition: "none",
				acceptanceMet: true,
				misApplied: false,
			},
		],
		[],
	);
	expect(report.compared).toBe(0);
	expect(report.acceptanceAgreementRate).toBeNull();
});

test("auxiliary metrics are labeled heuristics and never claim acceptance", () => {
	const m = auxiliaryMetrics({
		guidanceBody: "確認して報告する 手順",
		contextBodies: ["確認して報告する 資料"],
		usedRefs: ["a"],
		expectedContextRefs: ["a", "b"],
	});
	expect(m.method).toBe("eval_kit_token_overlap_v1");
	expect(m.faithfulnessOverlap).toBeGreaterThan(0);
	expect(m.contextRelevanceAtUsed).toBe(0.5);
});
