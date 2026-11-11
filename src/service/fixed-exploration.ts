import type {
	Build,
	GuidanceRequest,
	Policy,
	ReadyDecision,
} from "../contracts/types.js";
import { assembleSkillBody } from "./skill-document.js";
import { renderSkillMarkdown } from "./skill-markdown.js";
import { requireThat } from "./identity.js";

/** Authored once. Task facts come from the separate request when a reader uses the SKILL. */
const workflow = `### Establish what can be checked

Read the accompanying task and extract the target, intended result, constraints, and one observable success condition. Inspect available version manifests, configuration, and environment metadata using read-only access. Write down each confirmed value with its source and mark unknown values. If the target or authorized observation scope cannot be identified, ask for the missing fact and stop before interacting with the system.

### Check the versioned primary sources

Find the upstream manual, release notes, or maintained source for the actual component and version. Look up the exact behavior named in the task, including prerequisites, limits, failure modes, and supported recovery. Record the source, version and the passage that supports each proposed action. Keep a discrepancy open until you can reproduce it or find an authoritative explanation. Stop before any action that depends on an unresolved discrepancy.

### Design one bounded experiment

Use synthetic inputs and a disposable copy, fixture, emulator or other authorized isolated target. Record the baseline first. Vary one task-specific condition and compare its observable result against that baseline. Include one failure or interruption that should prevent the result from being trusted. Before the experiment, record the input, the variable, the observation, the expected result for each case, and the cleanup or recovery step. Confirm the copy can be discarded or restored before changing it. For a planning request, describe the experiment and leave execution pending.

### Record the decision

Record the target and version, source passages, input, baseline, changed result, elapsed time or other relevant metric, and any effect outside the test boundary. Use redacted summaries where records could include private data. Compare each observed result with its expected value. Stop if the target differs from the plan, isolation or recovery cannot be verified, an unexpected side effect occurs, or the result is ambiguous. Report the first unresolved condition and the next read-only check. Advance to a broader test only after the bounded results and authorization support it.`;

const name = "safe-task-exploration";
const description =
	"Plan and begin bounded exploration when a task has no confirmed specialist procedure and can start with authorized read-only checks.";
const decision: ReadyDecision = {
	kind: "ready",
	strategy: "provisional",
	sourceRefs: [],
	sections: [{ id: "workflow", body: workflow }],
	patches: [],
	requiredCapabilities: [],
	assumptions: [],
	verification: [
		"Record the exact target, version, authorized scope, and primary sources before proposing changes.",
		"Distinguish the planned experiment from observed results. Leave the outcome unverified until actual evidence supports it.",
	],
	name,
	title: "Explore an unfamiliar task safely",
	description,
	language: "en",
	localizedInstructions: workflow,
	domainAnchors: [
		{
			term: "target version",
			documentPointer: "Establish what can be checked",
		},
	],
	sourceReview: {
		assessment: "Owner-authored general exploration workflow.",
		flaggedItems: [],
	},
	nonSourceAdditions: [],
	document: {
		sections: [
			{
				kind: "principles",
				heading: "Scope",
				body: "This provisional workflow starts with observation and supports an isolated experiment. Use the authorization already granted. Stop before any action outside that scope and identify the authorization it requires. Keep production targets, customer data, and credentials outside the experiment.",
			},
			{ kind: "workflow", heading: "Procedure" },
			{ kind: "completion", heading: "Completion checks" },
		],
		provisionalNotice:
			"Exploration only. Results require observations from the target and version in the request.",
		references: [],
	},
};

export const FIXED_EXPLORATION_REF = "skillsmith:fixed-exploration";

export function fixedExploration(
	request: Pick<GuidanceRequest, "task" | "environment" | "audience">,
	policy: Policy,
) {
	const content: Build["content"] = {
		contractVersion: "skillsmith.v1",
		task: request.task,
		environment: request.environment,
		audience: request.audience,
		policy,
		body: "",
		decision: structuredClone(decision),
		dependencies: [],
	};
	// The caller supplies the bound request alongside this immutable SKILL.
	const presentation = {
		...content,
		task: { ...request.task, constraints: [] },
		policy: { ...policy, alreadyPresent: true },
	};
	content.body = presentation.body = assembleSkillBody(
		presentation,
		workflow,
		name,
	);
	const artifact = renderSkillMarkdown(presentation);
	requireThat(artifact.files && artifact.bundleDigest, "artifact_mismatch");
	return {
		content,
		artifact: {
			...artifact,
			files: artifact.files,
			bundleDigest: artifact.bundleDigest,
		},
	};
}
