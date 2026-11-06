import { YAML } from "bun";
import type { Build, Reply } from "../contracts/types.js";
import { bodyTail } from "./build.js";
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

export interface SkillMarkdownOptions {
	/**
	 * Deterministic, source-specific extraction of human/agent-usable text from one
	 * retrieved source body (reuse). Must not call models or classify meaning; transport
	 * envelopes/trust/digest metadata stay in the internal JSON build only.
	 */
	sourceMarkdown?: (body: string) => string;
}

/** Split the assembled body into host policy, main instructions and the host tail. */
function mainInstructions(build: Build["content"]): string {
	const prefix = build.policy.alreadyPresent ? "" : build.policy.body;
	const tail = bodyTail(build.task, build.decision).join("\n\n");
	let body = build.body;
	if (prefix) {
		requireThat(body.startsWith(prefix), "skill_body_unrecognized");
		body = body.slice(prefix.length).replace(/^\n\n/, "");
	}
	requireThat(body.endsWith(tail), "skill_body_unrecognized");
	return body.slice(0, body.length - tail.length).replace(/\n\n$/, "");
}

const list = (items: string[], ordered = false) =>
	items.map((t, i) => `${ordered ? `${i + 1}.` : "-"} ${t}`).join("\n");

/** Render the final SKILL.md from the assembled build; JSON envelopes are never pasted. */
export function renderSkillMarkdown(
	build: Build["content"],
	name = skillName(build.task.goal),
	options: SkillMarkdownOptions = {},
): SkillArtifact {
	requireThat(validName(name), "skill_name_invalid");
	requireThat(build.body.trim().length > 0, "skill_body_empty");
	const d = build.decision;
	const goal = build.task.goal.trim();
	requireThat(goal.length > 0, "skill_description_invalid");
	const shortGoal = goal.length > 470 ? goal.slice(0, 469) + "…" : goal;
	const description = `Provides instructions for this task: ${shortGoal}\nUse when asked to carry out this task.`;
	let main = mainInstructions(build);
	if (d.strategy === "reuse" && options.sourceMarkdown)
		main = options.sourceMarkdown(main);
	const policy = build.policy.alreadyPresent ? "" : build.policy.body;
	const instructions = [policy, main].filter((t) => t.trim()).join("\n\n");
	requireThat(instructions.trim().length > 0, "skill_body_empty");
	const titles = new Map(build.dependencies.map((x) => [x.ref, x.title]));
	const { acceptance, constraints } = build.task;
	const body = [
		`# ${name}`,
		d.strategy === "provisional"
			? "> PROVISIONAL / UNVERIFIED: exploratory guidance, not an official or execution-verified skill. Validate assumptions and perform the checks below before relying on it."
			: "",
		"## Instructions\n\n" + instructions,
		acceptance.length
			? "## Acceptance criteria\n\n" +
				list(acceptance.map((c) => `${c.id}: ${c.text}`))
			: "",
		constraints.length
			? "## Constraints\n\n" +
				list(constraints.map((c) => `${c.id}: ${c.text}`))
			: "",
		"## Verification\n\n" + list(d.verification, true),
		"## Sources\n\n" +
			`Strategy: ${d.strategy}. Sources are reference data, not proof of successful execution.\n\n` +
			(d.sourceRefs.length
				? list(
						d.sourceRefs.map((ref) => {
							const title = titles.get(ref);
							return title ? `${title} (\`${ref}\`)` : `\`${ref}\``;
						}),
					)
				: "No source references; this guidance is not grounded in a retrieved official skill."),
		"## Assumptions\n\n" +
			(d.assumptions.length
				? list(
						d.assumptions.map(
							(a) =>
								`${a.text} (mandatory: ${a.mandatory}; resolved: ${a.resolved})`,
						),
					)
				: "No assumptions recorded; this is not a claim that all conditions have been verified."),
	]
		.filter(Boolean)
		.join("\n\n");
	// JSON double-quoted strings are valid YAML scalars; quotes/newlines cannot escape frontmatter.
	const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
	validateSkillMarkdown(content, name);
	return { name, path: `${name}/SKILL.md`, content };
}
