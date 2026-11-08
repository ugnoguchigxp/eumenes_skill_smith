import type {
	ApprovedSkill,
	PreparedSkillSelection,
} from "../contracts/approved-skills.js";
import type { Authority } from "../contracts/types.js";
import type { Ports } from "../contracts/ports.js";
import { artifactDigest, digest, requireThat } from "./identity.js";
import {
	skillBundleDigest,
	validateSkillMarkdownFormat,
} from "./skill-markdown.js";
import { resolveAssembly } from "./assembly.js";
export function publicationDigest(r: Omit<ApprovedSkill, "digest">) {
	return digest({
		ref: r.ref,
		scope: r.scope,
		approvalRef: r.approvalRef,
		applicability: r.applicability,
		artifact: r.artifact,
		template: r.template,
		expiresAt: r.expiresAt,
	});
}
export function checkArtifact(r: ApprovedSkill) {
	const a = r.artifact;
	validateSkillMarkdownFormat(a.content, a.name);
	requireThat(
		a.path === `${a.name}/SKILL.md` && a.digest === artifactDigest(a.content),
		"artifact_mismatch",
	);
	const paths = new Set<string>();
	for (const f of a.files) {
		requireThat(
			f.path.startsWith(a.name + "/") &&
				/^references\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(
					f.path.slice(a.name.length + 1),
				) &&
				!paths.has(f.path) &&
				f.digest === artifactDigest(f.content),
			"artifact_mismatch",
		);
		paths.add(f.path);
	}
	requireThat(
		a.bundleDigest === skillBundleDigest(a, a.files),
		"artifact_mismatch",
	);
	requireThat(r.digest === publicationDigest(r), "publication_mismatch");
}
export function available<Tx>(
	p: Ports<Tx>,
	tx: Tx,
	r: ApprovedSkill,
	auth: Authority,
) {
	checkArtifact(r);
	const assembly = resolveAssembly(p.assemblyMode ?? "baseline");
	const generatorOk = r.template.generator
		? r.template.generator.instructions === assembly.instructionVersion
		: assembly.mode === "legacy";
	return (
		generatorOk &&
		r.scope === auth.scope &&
		r.expiresAt > p.now() &&
		!p.repository.blocked(tx, r.ref) &&
		!p.repository.blocked(tx, r.template.ref) &&
		!!p.approvedSkills?.approvalCurrent(tx, r) &&
		p.authority.valid(tx, auth, [
			r.ref,
			...r.template.content.dependencies.map((d) => d.ref),
		]) &&
		p.policy.current(tx, r.template.content.policy.version) &&
		p.registry.current(
			tx,
			auth,
			r.template.content.dependencies
				.filter((d) => !d.external)
				.map((d) => d.version),
		)
	);
}
export function compatible(
	r: ApprovedSkill,
	request: PreparedSkillSelection["request"],
) {
	const env = r.template.content.environment;
	return (
		env.id === request.environment.id &&
		digest(env.policy) === digest(request.environment.policy) &&
		r.template.content.audience === request.audience &&
		r.template.content.decision.requiredCapabilities.every((id) => {
			const capability = env.capabilities.find((c) => c.id === id);
			return (
				capability &&
				request.environment.capabilities.some(
					(c) => digest(c) === digest(capability),
				)
			);
		})
	);
}
