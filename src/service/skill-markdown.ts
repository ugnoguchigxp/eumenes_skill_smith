import { YAML } from "bun";
import type { Build, Reply } from "../contracts/types.js";
import { digest, requireThat } from "./identity.js";

export type SkillReply =
	| Exclude<Reply, { kind: "ready" }>
	| (Extract<Reply, { kind: "ready" }> & { skill: SkillArtifact });

export interface SkillArtifact {
	name: string;
	path: string;
	content: string;
}

const validName = (name: string) =>
	name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

/** Goal identity, not keyword/semantic classification. Explicit names are never repaired. */
export function skillName(goal: string): string {
	const slug = goal
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 51)
		.replace(/-$/g, "");
	return `${slug || "skill"}-${digest(goal).slice(0, 12)}`;
}

/** Structural format validation only; not a safety, semantic, or execution verdict. */
export function validateSkillMarkdown(
	content: string,
	directoryName?: string,
): void {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
	requireThat(match, "skill_frontmatter_missing");
	let parsed: unknown;
	try {
		parsed = YAML.parse(match[1]!);
	} catch {
		requireThat(false, "skill_frontmatter_invalid");
	}
	requireThat(
		parsed && typeof parsed === "object" && !Array.isArray(parsed),
		"skill_frontmatter_invalid",
	);
	const fields = parsed as Record<string, unknown>;
	const allowed = new Set([
		"name",
		"description",
		"license",
		"compatibility",
		"metadata",
		"allowed-tools",
	]);
	requireThat(
		Object.keys(fields).every((key) => allowed.has(key)),
		"skill_frontmatter_field_invalid",
	);
	requireThat(
		typeof fields.name === "string" && validName(fields.name),
		"skill_name_invalid",
	);
	requireThat(
		directoryName === undefined || fields.name === directoryName,
		"skill_directory_mismatch",
	);
	requireThat(
		typeof fields.description === "string" &&
			fields.description.trim().length > 0 &&
			fields.description.length <= 1024,
		"skill_description_invalid",
	);
	requireThat(match[2]!.trim().length > 0, "skill_body_empty");
}

/** Render the host-assembled body: reuse already includes the actual selected source body. */
export function renderSkillMarkdown(
	build: Build["content"],
	name = skillName(build.task.goal),
): SkillArtifact {
	requireThat(validName(name), "skill_name_invalid");
	requireThat(build.body.trim().length > 0, "skill_body_empty");
	const d = build.decision;
	const goal = build.task.goal.trim();
	requireThat(goal.length > 0, "skill_description_invalid");
	const shortGoal = goal.length > 470 ? goal.slice(0, 469) + "…" : goal;
	const description = `Provides instructions for this task: ${shortGoal}\nUse when asked to carry out this task.`;
	const body = [
		`# ${name}`,
		d.strategy === "provisional"
			? "> PROVISIONAL / UNVERIFIED: exploratory guidance, not an official or execution-verified skill. Validate assumptions and perform the checks below before relying on it."
			: "",
		"## Instructions and checks\n\n" + build.body,
		"## Verification\n\n" +
			d.verification.map((v, i) => `${i + 1}. ${v}`).join("\n"),
		"## Provenance\n\nStrategy: " +
			d.strategy +
			". Source references are provenance, not proof of successful execution.\n\n" +
			(d.sourceRefs.length
				? d.sourceRefs.map((ref) => "- " + JSON.stringify(ref)).join("\n")
				: "No source references; this guidance is not grounded in a retrieved official skill."),
		"## Assumptions\n\n" +
			(d.assumptions.length
				? d.assumptions
						.map(
							(a) =>
								`- ${a.text} (mandatory: ${a.mandatory}; resolved: ${a.resolved})`,
						)
						.join("\n")
				: "No assumptions recorded; this is not a claim that all conditions have been verified."),
	]
		.filter(Boolean)
		.join("\n\n");
	// JSON double-quoted strings are valid YAML scalars; quotes/newlines cannot escape frontmatter.
	const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
	validateSkillMarkdown(content, name);
	return { name, path: `${name}/SKILL.md`, content };
}
