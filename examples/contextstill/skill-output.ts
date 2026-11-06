import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateSkillMarkdown, type SkillArtifact } from "../../src/index.js";

export function writeSkillArtifact(
	outputDir: string,
	skill: SkillArtifact,
): string {
	validateSkillMarkdown(skill.content, skill.name);
	if (skill.path !== `${skill.name}/SKILL.md`)
		throw new Error("skill_path_invalid");
	const path = resolve(outputDir, skill.path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, skill.content);
	return path;
}
