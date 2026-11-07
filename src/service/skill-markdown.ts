import { validateModelMarkdown } from "./model-markdown.js";
import { z } from "zod";
import { YAML } from "bun";
import {
	skillPresentationSchema,
	skillNameSchema,
} from "../contracts/schema.js";
import type { Build, Reply } from "../contracts/types.js";
import { legacyMainInstructions } from "./legacy-content.js";
import { assembleSkillBody } from "./skill-document.js";
export {
	hostEntries,
	checkLocalizedHost,
	markdownPlainText,
} from "./skill-document.js";
import { artifactDigest, digest, requireThat } from "./identity.js";

export const SKILL_RENDERER_VERSION = "skill-markdown.v11";

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
	bundleDigest?: string;
	files?: { path: string; content: string; digest: string }[];
}

/** Explicit whole-bundle identity; SKILL content digest retains its old byte contract. */
export function skillBundleDigest(
	main: { path: string; digest: string },
	files: { path: string; digest: string }[],
) {
	return digest([
		{ path: main.path, digest: main.digest },
		...files.map(({ path, digest }) => ({ path, digest })),
	]);
}

/** Audit projection is separate from SKILL content; callers may persist it as a sidecar. */
export function skillAuditMetadata(build: Build["content"]) {
	return structuredClone({
		task: build.task,
		policy: build.policy,
		dependencies: build.dependencies,
		decision: build.decision,
	});
}

const validName = (name: string) => skillNameSchema.safeParse(name).success;

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

const clip = (t: string, n: number) =>
	t.length > n ? t.slice(0, n - 1) + "…" : t;

/** Model description first; deterministic Japanese fallback for legacy records only. */
function describe(build: Build["content"]): string {
	return (
		build.decision.description ??
		`${build.decision.strategy === "provisional" ? "未検証の操作を安全に探索する手順を提供する。" : "この作業の手順を提供する。"}次の作業を頼まれたときに使う: ${clip(build.task.goal.trim(), 400)}`
	);
}

/** Structural format validation only; not a safety, semantic, or execution verdict. */
export function validateSkillMarkdownFormat(
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
	const optionalFields = z.object({
		license: z.string().optional(),
		compatibility: z.string().min(1).max(500).optional(),
		metadata: z.record(z.string(), z.string()).optional(),
		"allowed-tools": z.string().optional(),
	});
	requireThat(
		optionalFields.safeParse(fields).success,
		"skill_frontmatter_optional_invalid",
	);
	requireThat(match[2]!.trim().length > 0, "skill_body_empty");
}

/** Backwards-compatible alias; FORMAT only, not a safety verdict. */
export const validateSkillMarkdown = validateSkillMarkdownFormat;
export const SKILL_FORMAT_VERSION = "agent-skills-frontmatter-ascii.v2";

export interface SkillMarkdownOptions {
	/**
	 * Deterministic, source-specific extraction of human/agent-usable text from one
	 * retrieved source body (reuse). Must not call models or classify meaning; transport
	 * envelopes/trust/digest metadata stay in the internal JSON build only.
	 */
	sourceMarkdown?: (body: string) => string;
	sourceMarkdownVersion?: string;
}

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
		document: d.document,
		title: d.title,
		description: d.description,
		language: d.language,
		localizedInstructions: d.localizedInstructions,
		localizedHost: d.localizedHost,
		sourceReview: d.sourceReview,
		nonSourceAdditions: d.nonSourceAdditions,
	};
	if (Object.values(presentation).some((v) => v !== undefined))
		requireThat(
			skillPresentationSchema.safeParse(presentation).success,
			"incomplete_skill_presentation",
		);
	requireThat(build.task.goal.trim().length > 0, "skill_description_invalid");
	const description = describe(build);
	let body: string;
	if (d.localizedInstructions === undefined) {
		// Only explicit archival content can reach this branch.
		let main = legacyMainInstructions(build);
		if (d.strategy === "reuse" && options.sourceMarkdown) {
			try {
				main = options.sourceMarkdown(main);
			} catch {
				requireThat(false, "skill_source_extract_failed");
			}
			requireThat(
				typeof main === "string" && main.trim().length > 0,
				"skill_source_body_empty",
			);
		}
		body = assembleSkillBody(build, main, name);
	} else {
		const canonical = assembleSkillBody(build, d.localizedInstructions, name);
		requireThat(build.body === canonical, "skill_body_mismatch");
		body = build.body;
	}

	// JSON double-quoted strings are valid YAML scalars; quotes/newlines cannot escape frontmatter.
	const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
	validateSkillMarkdown(content, name);
	const files = d.document?.references.map((ref) => ({
		path: `${name}/${ref.path}`,
		content: ref.content,
		digest: artifactDigest(ref.content),
	}));
	return {
		name,
		path: `${name}/SKILL.md`,
		content,
		...(files
			? {
					files,
					bundleDigest: skillBundleDigest(
						{ path: `${name}/SKILL.md`, digest: artifactDigest(content) },
						files,
					),
				}
			: {}),
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
