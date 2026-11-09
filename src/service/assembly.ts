import type { Evidence, ReadyDecision, Section } from "../contracts/types.js";
import type {
	CompactReadyDecision,
	ExplorationSlots,
} from "../contracts/schema.js";
import {
	compactModelTurnSchema,
	legacyModelTurnSchema,
	modelTurnSchema,
} from "../contracts/schema.js";
import {
	buildInstructions,
	disclosureInstructions,
	compactBuildInstructions,
	COMPACT_INSTRUCTION_VERSION,
	INSTRUCTION_VERSION,
	leanBuildInstructions,
	LEAN_INSTRUCTION_VERSION,
} from "../instructions/build.js";
import { digest, requireThat } from "./identity.js";

export type AssemblyMode = "baseline" | "compact" | "lean" | "legacy";

export type AssemblyProfile = {
	mode: AssemblyMode;
	instructions: string;
	instructionVersion: string;
	turnSchema:
		| typeof modelTurnSchema
		| typeof compactModelTurnSchema
		| typeof legacyModelTurnSchema;
};

export function resolveAssembly(
	mode: AssemblyMode = "baseline",
): AssemblyProfile {
	if (mode === "legacy")
		return {
			mode,
			instructions: disclosureInstructions,
			instructionVersion: "build." + digest(disclosureInstructions),
			turnSchema: legacyModelTurnSchema,
		};
	if (mode === "compact")
		return {
			mode,
			instructions: compactBuildInstructions,
			instructionVersion: COMPACT_INSTRUCTION_VERSION,
			turnSchema: compactModelTurnSchema,
		};
	if (mode === "lean")
		return {
			mode,
			instructions: leanBuildInstructions,
			instructionVersion: LEAN_INSTRUCTION_VERSION,
			turnSchema: modelTurnSchema,
		};
	return {
		mode: "baseline",
		instructions: buildInstructions,
		instructionVersion: INSTRUCTION_VERSION,
		turnSchema: modelTurnSchema,
	};
}

const EXPLORATION_SECTIONS: {
	id: string;
	key: keyof ExplorationSlots;
}[] = [
	{ id: "target-version", key: "targetAndVersion" },
	{ id: "official-sources", key: "officialSources" },
	{ id: "first-safe-observation", key: "firstSafeObservation" },
	{ id: "isolated-experiment", key: "isolatedExperiment" },
	{ id: "pass-stop-conditions", key: "passStopConditions" },
	{ id: "unresolved-assumptions", key: "unresolvedAssumptions" },
];

export function sectionsFromExploration(
	exploration: ExplorationSlots,
): Section[] {
	return EXPLORATION_SECTIONS.map(({ id, key }) => ({
		id,
		body: exploration[key],
	}));
}

/** Drop compact-only fields and materialize exploration into stored ready sections. */
export function toStoredReady(decision: CompactReadyDecision): ReadyDecision {
	const { coverage: _coverage, exploration, ...rest } = decision;
	if (exploration) {
		requireThat(
			!rest.sections.length && !rest.patches.length,
			"invalid_exploration",
		);
		requireThat(rest.strategy === "provisional", "invalid_exploration");
		return { ...rest, sections: sectionsFromExploration(exploration) };
	}
	return rest;
}

/** Structural: identical or near-entire copy of a disclosed evidence body into sections. */
export function isNearEntireCopy(candidate: string, source: string): boolean {
	const a = candidate.trim();
	const b = source.trim();
	if (a.length < 32 || b.length < 32) return false;
	if (a === b) return true;
	if (a.includes(b) && b.length >= a.length * 0.85) return true;
	if (b.includes(a) && a.length >= b.length * 0.85) return true;
	return false;
}

export function rejectDisclosedBodyRewrite(
	decision: ReadyDecision,
	evidence: Evidence[],
) {
	if (
		decision.strategy !== "adapt" &&
		decision.strategy !== "compose" &&
		decision.strategy !== "provisional"
	)
		return;
	if (!decision.sections.length) return;
	const bodies: string[] = [];
	for (const ref of decision.sourceRefs) {
		const e = evidence.find((item) => item.ref === ref);
		if (!e) continue;
		bodies.push(e.body);
		for (const section of e.sections ?? []) bodies.push(section.body);
	}
	for (const section of decision.sections) {
		requireThat(
			!bodies.some((body) => isNearEntireCopy(section.body, body)),
			"invalid_rewrite",
		);
	}
}
