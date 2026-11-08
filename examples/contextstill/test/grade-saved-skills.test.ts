import { describe, expect, test } from "bun:test";
import {
	validateSkillGrade,
	weightedSkillScore,
} from "../grade-saved-skills.js";

const dimension = (score: number) => ({
	score,
	reason: "The named condition is observable.",
});
const grade = {
	correctness: dimension(8),
	actionability: dimension(7),
	coverage: dimension(6),
	concision: dimension(9),
	format: dimension(10),
	criteria: [
		{
			id: "gate",
			status: "met" as const,
			passageId: "p0",
			reason: "A count mismatch stops progress.",
		},
	],
	issues: [],
};
const material = {
	taskId: "fixture",
	acceptanceCriteria: [{ id: "gate", text: "Require a count gate." }],
	artifactToEvaluate: { main: "Stop when the count differs." },
};
describe("frozen skill grading contracts", () => {
	test("weights each dimension independently on a 100-point scale", () => {
		expect(weightedSkillScore(grade)).toBe(76.5);
		expect(
			weightedSkillScore({
				...grade,
				correctness: dimension(10),
				actionability: dimension(10),
				coverage: dimension(10),
				concision: dimension(10),
			}),
		).toBe(100);
	});
	test("resolves evidence to the actual bundled reference", () => {
		const result = validateSkillGrade(
			{ ...grade, criteria: [{ ...grade.criteria[0]!, passageId: "p1" }] },
			{
				...material,
				artifactToEvaluate: {
					main: "See the reference.",
					files: [{ content: "Stop when the count differs." }],
				},
			},
		);
		expect(result.total).toBe(76.5);
		expect(result.evidence[0]?.path).toBe("artifact.files.0.content");
		expect(result.evidence[0]?.text).toBe("Stop when the count differs.");
	});
	test("rejects a passage absent from the artifact", () => {
		expect(() =>
			validateSkillGrade(grade, {
				...material,
				artifactToEvaluate: {},
			}),
		).toThrow("grade_passage_not_in_artifact");
	});
	test("rejects omitted or duplicated acceptance criteria", () => {
		expect(() =>
			validateSkillGrade({ ...grade, criteria: [] }, material),
		).toThrow("grade_criteria_mismatch");
		expect(() =>
			validateSkillGrade(
				{ ...grade, criteria: [...grade.criteria, ...grade.criteria] },
				material,
			),
		).toThrow("grade_criteria_mismatch");
	});
});
