import { validateModelMarkdown } from "./model-markdown.js";
import { YAML } from "bun";
import { skillPresentationSchema } from "../contracts/schema.js";
import type { Build, Reply } from "../contracts/types.js";
import { bodyTail } from "./build.js";
import { artifactDigest, digest, requireThat } from "./identity.js";

export const SKILL_RENDERER_VERSION = "skill-markdown.v3";

export type SkillReply =
	| Exclude<Reply, { kind: "ready" }>
	| (Extract<Reply, { kind: "ready" }> & { skill: SkillArtifact });

export interface SkillArtifact {
	digest: string;
	rendererVersion: string;
	sourceExtractorVersion: string;
	name: string;
	path: string;
	content: string;
}

const validName = (name: string) =>
	name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

const slug = (text: string, max: number) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, max)
		.replace(/-$/g, "");

/** Goal identity, not keyword/semantic classification. Explicit names are never repaired. */
export function skillName(goal: string): string {
	return `${slug(goal, 51) || "skill"}-${digest(goal).slice(0, 12)}`;
}

/**
 * Current builds use the model name. Legacy reuse ⇒ primary source title (Agent Skills spec,
 * ≤64); empty slug or other strategies ⇒ goal identity. Deterministic per build.
 */
export function defaultSkillName(build: Build["content"]): string {
	const d = build.decision;
	if (d.name !== undefined) return d.name;
	if (d.strategy === "reuse") {
		const title = build.dependencies.find(
			(x) => x.ref === d.sourceRefs[0],
		)?.title;
		const s = title ? slug(title, 64) : "";
		if (s && validName(s)) return s;
	}
	return skillName(build.task.goal);
}

const STRATEGY: Record<string, string> = {
	reuse: "再利用",
	adapt: "改変",
	compose: "組み合わせ",
	provisional: "暫定",
};

/** Plain text at Markdown interpolation boundaries; controls cannot create blocks. */
export const markdownPlainText = (text: string) =>
	text
		.replace(
			// eslint-disable-next-line no-control-regex -- flatten controls at the trust boundary
			/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
			" ",
		)
		.replace(/[\\`*_{}[\]()#+.!|~=-]/g, (c) => `\\${c}`)
		.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

const clip = (t: string, n: number) =>
	t.length > n ? t.slice(0, n - 1) + "…" : t;

/** Model description first; deterministic Japanese fallback for legacy records only. */
function describe(build: Build["content"]): string {
	return (
		build.decision.description ??
		`${build.decision.strategy === "provisional" ? "公式の根拠が無いため、未検証の暫定的な探索手順を提供する。" : "この作業の手順を提供する。"}次の作業を頼まれたときに使う: ${clip(build.task.goal.trim(), 400)}`
	);
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
	sourceMarkdownVersion?: string;
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

export function hostEntries(
	task: Build["content"]["task"],
	d: Build["content"]["decision"],
) {
	return [
		...task.acceptance.map((c) => ({ id: "acceptance:" + c.id, text: c.text })),
		...task.constraints.map((c) => ({
			id: "constraint:" + c.id,
			text: c.text,
		})),
		...d.verification.map((text, i) => ({ id: "verification:" + i, text })),
		...d.assumptions.map((a, i) => ({ id: "assumption:" + i, text: a.text })),
	];
}
export function checkLocalizedHost(
	task: Build["content"]["task"],
	d: Build["content"]["decision"],
) {
	if (!d.localizedHost) return;
	const expected = hostEntries(task, d).map((x) => x.id);
	requireThat(
		d.localizedHost.length === expected.length &&
			new Set(d.localizedHost.map((x) => x.id)).size === expected.length &&
			d.localizedHost.every((x) => expected.includes(x.id)),
		"localized_host_ids_invalid",
	);
}

const list = (items: string[], ordered = false) =>
	items.map((t, i) => `${ordered ? `${i + 1}.` : "-"} ${t}`).join("\n");

/** Render the final SKILL.md from the assembled build; JSON envelopes are never pasted. */
export function renderSkillMarkdown(
	build: Build["content"],
	name = defaultSkillName(build),
	options: SkillMarkdownOptions = {},
): SkillArtifact {
	requireThat(validName(name), "skill_name_invalid");
	requireThat(build.body.trim().length > 0, "skill_body_empty");
	const d = build.decision;
	if (d.localizedInstructions !== undefined)
		validateModelMarkdown(d.title ?? name, d.localizedInstructions);
	const presentation = {
		name: d.name,
		title: d.title,
		description: d.description,
		language: d.language,
		localizedInstructions: d.localizedInstructions,
		localizedHost: d.localizedHost,
	};
	if (Object.values(presentation).some((v) => v !== undefined))
		requireThat(
			skillPresentationSchema.safeParse(presentation).success,
			"incomplete_skill_presentation",
		);
	requireThat(build.task.goal.trim().length > 0, "skill_description_invalid");
	const titles = new Map(build.dependencies.map((x) => [x.ref, x.title]));
	const description = describe(build);
	let main = d.localizedInstructions ?? mainInstructions(build);
	if (
		d.localizedInstructions === undefined &&
		d.strategy === "reuse" &&
		options.sourceMarkdown
	)
		main = options.sourceMarkdown(main);
	const policy = build.policy.alreadyPresent ? "" : build.policy.body;
	const instructions = [policy, main].filter((t) => t.trim()).join("\n\n");
	requireThat(instructions.trim().length > 0, "skill_body_empty");
	const { acceptance, constraints } = build.task;
	checkLocalizedHost(build.task, d);
	const hostText = (id: string, original: string) => {
		const localized = d.localizedHost?.find((x) => x.id === id)?.text;
		return localized ? `${localized}（原文: ${original}）` : original;
	};
	const legacyBody = [
		`# ${markdownPlainText(d.title ?? name)}`,
		d.strategy === "provisional"
			? "> 暫定・未検証: 探索のための指針であり、公式の Skill でも実行で確かめた Skill でもない。頼る前に前提を確かめ、下の確認を行うこと。"
			: "",
		"## 手順\n\n" + instructions,
		acceptance.length
			? "## 受け入れ条件\n\n" +
				list(
					acceptance.map(
						(c) => `${c.id}: ${hostText("acceptance:" + c.id, c.text)}`,
					),
				)
			: "",
		constraints.length
			? "## 制約\n\n" +
				list(
					constraints.map(
						(c) => `${c.id}: ${hostText("constraint:" + c.id, c.text)}`,
					),
				)
			: "",
		"## 確認\n\n" +
			list(
				d.verification.map((v, i) => hostText("verification:" + i, v)),
				true,
			),
		"## 出典\n\n" +
			`方針: ${STRATEGY[d.strategy] ?? d.strategy}。出典は参照用の資料であり、実行に成功した証拠ではない。\n\n` +
			(d.sourceRefs.length
				? list(
						d.sourceRefs.map((ref) => {
							const title = titles.get(ref);
							return title
								? `${markdownPlainText(title)}（\`${markdownPlainText(ref)}\`）`
								: `\`${markdownPlainText(ref)}\``;
						}),
					)
				: "出典なし。この指針は検索で得た公式の Skill に基づいていない。"),
		"## 前提\n\n" +
			(d.assumptions.length
				? list(
						d.assumptions.map(
							(a) =>
								a.text +
								(a.mandatory
									? a.resolved
										? "（必須・解決済み）"
										: "（必須・未解決）"
									: ""),
						),
					)
				: "記録された前提なし。すべての条件を確かめたという意味ではない。"),
	]
		.filter(Boolean)
		.join("\n\n");
	const body = legacyBody;
	// JSON double-quoted strings are valid YAML scalars; quotes/newlines cannot escape frontmatter.
	const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
	validateSkillMarkdown(content, name);
	return {
		name,
		path: `${name}/SKILL.md`,
		content,
		digest: artifactDigest(content),
		rendererVersion: SKILL_RENDERER_VERSION,
		sourceExtractorVersion:
			d.localizedInstructions === undefined &&
			d.strategy === "reuse" &&
			options.sourceMarkdown
				? (options.sourceMarkdownVersion ?? "unversioned")
				: "none",
	};
}
