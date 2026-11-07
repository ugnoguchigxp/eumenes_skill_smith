import { skillBundleDigest } from "../../src/service/skill-markdown.js";
import { referencePathSchema } from "../../src/contracts/schema.js";
import { artifactDigest } from "../../src/service/identity.js";
import { mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { validateSkillMarkdown, type SkillArtifact } from "../../src/index.js";

export function writeSkillArtifact(
	outputDir: string,
	skill: SkillArtifact,
): string {
	validateSkillMarkdown(skill.content, skill.name);
	if (skill.path !== `${skill.name}/SKILL.md`)
		throw new Error("skill_path_invalid");
	if (skill.digest !== artifactDigest(skill.content))
		throw new Error("skill_artifact_digest_mismatch");
	const files = skill.files ?? [];
	if (
		files.length > 8 ||
		new Set(files.map((f) => f.path)).size !== files.length
	)
		throw new Error("skill_files_invalid");
	for (const file of files) {
		if (
			!file.path.startsWith(`${skill.name}/`) ||
			!referencePathSchema.safeParse(file.path.slice(skill.name.length + 1))
				.success
		)
			throw new Error("skill_reference_path_invalid");
		if (file.digest !== artifactDigest(file.content))
			throw new Error("skill_reference_digest_mismatch");
	}
	if (
		(files.length > 0 && !skill.bundleDigest) ||
		(skill.bundleDigest &&
			skill.bundleDigest !== skillBundleDigest(skill, files))
	)
		throw new Error("skill_bundle_digest_mismatch");
	const root = resolve(outputDir);
	// Check every path before creating/writing anything. Never traverse an existing symlink.
	for (const rel of [skill.path, ...files.map((f) => f.path)]) {
		let path = root;
		for (const part of relative(root, resolve(root, rel)).split(sep)) {
			path = resolve(path, part);
			try {
				if (lstatSync(path).isSymbolicLink())
					throw new Error("skill_output_symlink");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	const path = resolve(outputDir, skill.path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, skill.content);
	for (const file of files) {
		const target = resolve(outputDir, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.content);
	}
	return path;
}
