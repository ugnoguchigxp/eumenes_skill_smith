import type { Build } from "../contracts/types.js";
import type { SkillDelivery } from "../contracts/approved-skills.js";
import { skillBundleDigest, type SkillArtifact } from "./skill-markdown.js";

/** One canonical public projection, also used for the final generation capacity check. */
export function skillDeliveryPacket(
	requestRef: string,
	build: Build,
	skill: SkillArtifact,
): Extract<SkillDelivery, { kind: "ready" }> {
	return {
		contractVersion: "skillsmith.delivery.v1",
		kind: "ready",
		requestRef,
		auditRef: build.ref,
		skill: {
			...skill,
			files: skill.files ?? [],
			bundleDigest:
				skill.bundleDigest ?? skillBundleDigest(skill, skill.files ?? []),
		},
		...(build.publication?.exploration
			? { exploration: true as const }
			: build.publication?.composition
				? {
						compositionRefs: build.publication.composition.parts.map(
							(p) => p.ref,
						),
					}
				: { publicationRef: build.publication?.ref }),
		dependencyVersions: build.content.dependencies.map((d) => d.version),
	};
}
