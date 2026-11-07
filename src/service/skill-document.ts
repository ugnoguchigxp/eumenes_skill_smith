import type { Build } from "../contracts/types.js";
import { skillDocumentSchema } from "../contracts/schema.js";
import { validateModelMarkdown } from "./model-markdown.js";
import { requireThat } from "./identity.js";
/** Flatten every block/control boundary before any Markdown interpolation. */
const singleLineText = (text: string) =>
	text.replace(
		// eslint-disable-next-line no-control-regex -- flatten controls at the trust boundary
		/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
		" ",
	);
/** Escaped Markdown text (never an HTML/Markdown structure). */
export const markdownPlainText = (text: string) =>
	singleLineText(text)
		.replace(/[\\`*_[\]#|~]/g, (c) => `\\${c}`)
		.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
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

/** Pure canonical projection: structured host data and the instruction section only. */
export function assembleSkillBody(
	build: Pick<
		Build["content"],
		"task" | "decision" | "dependencies" | "policy"
	>,
	main: string,
	name: string,
): string {
	const d = build.decision;
	const policy = build.policy.alreadyPresent ? "" : build.policy.body;
	const instructions = [policy, main].filter((t) => t.trim()).join("\n\n");
	requireThat(instructions.trim().length > 0, "skill_body_empty");
	checkLocalizedHost(build.task, d);
	const hostText = (id: string, original: string) => {
		const localized = d.localizedHost?.find((x) => x.id === id)?.text;
		return localized
			? d.document
				? markdownPlainText(localized)
				: `${markdownPlainText(localized)}（原文: ${markdownPlainText(original)}）`
			: markdownPlainText(original);
	};
	const checks = [
		...build.task.constraints
			.filter((x) => !x.visibility || x.visibility === "reader")
			.map((c) => hostText("constraint:" + c.id, c.text)),
		...d.assumptions.flatMap((a, i) =>
			!a.visibility || a.visibility === "reader"
				? [
						(d.document ? "" : "適用前に確認する: ") +
							hostText("assumption:" + i, a.text),
					]
				: [],
		),
		...d.verification.map((v, i) => hostText("verification:" + i, v)),
	];
	let body = [
		`# ${markdownPlainText(d.title ?? name)}`,
		"## 手順\n\n" +
			(d.strategy === "provisional"
				? "> 暫定・未検証。適用条件を確認し、停止条件に達したら進めない。\n\n"
				: "") +
			instructions,
		"## 確認\n\n" + list(checks, true),
	].join("\n\n");
	if (d.document) {
		const doc = skillDocumentSchema.parse(d.document);
		requireThat(
			doc.sections.some((section) => section.kind === "principles"),
			"skill_principles_missing",
		);
		requireThat(
			d.strategy !== "provisional" || !!doc.provisionalNotice,
			"skill_provisional_notice_missing",
		);
		for (const section of doc.sections) {
			validateModelMarkdown(section.heading, section.body ?? "");
		}
		for (const ref of doc.references)
			validateModelMarkdown(ref.title, ref.content);
		if (doc.resourceHeading) validateModelMarkdown(doc.resourceHeading, "");
		if (doc.provisionalNotice) validateModelMarkdown(doc.provisionalNotice, "");
		body = [
			`# ${markdownPlainText(d.title ?? name)}`,
			...doc.sections.map((section) => {
				const content =
					section.kind === "workflow"
						? [
								doc.provisionalNotice && d.strategy === "provisional"
									? `> ${markdownPlainText(doc.provisionalNotice)}`
									: "",
								instructions,
							]
								.filter(Boolean)
								.join("\n\n")
						: section.kind === "completion"
							? [section.body, list(checks, true)].filter(Boolean).join("\n\n")
							: section.body;
				return `## ${markdownPlainText(section.heading)}\n\n${content}`;
			}),
			...(doc.references.length
				? [
						`## ${markdownPlainText(doc.resourceHeading!)}\n\n` +
							doc.references
								.map(
									(ref) => `- [${markdownPlainText(ref.title)}](${ref.path})`,
								)
								.join("\n"),
					]
				: []),
		].join("\n\n");
	}
	// Exact identifiers are structural provenance, not a vocabulary-based meaning judgement.
	requireThat(
		d.sourceRefs.every((ref) =>
			[body, ...(d.document?.references.map((r) => r.content) ?? [])].every(
				(text) => !text.includes(ref) && !text.includes(markdownPlainText(ref)),
			),
		),
		"skill_provenance_in_body",
	);
	return body;
}
