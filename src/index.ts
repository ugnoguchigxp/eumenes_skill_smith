export * from "./contracts/schema.js";
export {
	defaultServiceLimits,
	resolveServiceLimits,
	serviceLimitsSchema,
} from "./contracts/limits.js";
export type { ServiceLimits } from "./contracts/limits.js";
export type * from "./contracts/types.js";
export type * from "./contracts/ports.js";
export { createSkillSmith } from "./service/index.js";
export { SkillSmithError, canonical, digest } from "./service/identity.js";
export {
	renderSkillMarkdown,
	validateSkillMarkdown,
	validateSkillMarkdownFormat,
	SKILL_FORMAT_VERSION,
	skillName,
	defaultSkillName,
} from "./service/skill-markdown.js";
export type {
	SkillArtifact,
	SkillMarkdownOptions,
	SkillReply,
} from "./service/skill-markdown.js";

export * from "./contracts/approved-skills.js";
export { assembleApprovedParts } from "./service/approved-composition.js";

export {
	BUILD_JOB_KIND,
	buildJobPayloadSchema,
	createBuildQueueJobs,
	createBuildJobHandler,
} from "./integration/queue.js";
export type { BuildQueue, BuildJobHandler } from "./integration/queue.js";
export {
	createEumenesInference,
	type EumenesControl,
} from "./integration/eumenes-inference.js";
