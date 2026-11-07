import type { Build } from "../contracts/types.js";
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
			? `${markdownPlainText(localized)}（原文: ${markdownPlainText(original)}）`
			: markdownPlainText(original);
	};
	const checks = [
		...build.task.constraints
			.filter((x) => !x.visibility || x.visibility === "reader")
			.map((c) => hostText("constraint:" + c.id, c.text)),
		...d.assumptions.flatMap((a, i) =>
			!a.visibility || a.visibility === "reader"
				? ["適用前に確認する: " + hostText("assumption:" + i, a.text)]
				: [],
		),
		...d.verification.map((v, i) => hostText("verification:" + i, v)),
	];
	const body = [
		`# ${markdownPlainText(d.title ?? name)}`,
		"## 手順\n\n" +
			(d.strategy === "provisional"
				? "> 暫定・未検証。適用条件を確認し、停止条件に達したら進めない。\n\n"
				: "") +
			instructions,
		"## 確認\n\n" + list(checks, true),
	].join("\n\n");
	// Exact identifiers are structural provenance, not a vocabulary-based meaning judgement.
	requireThat(
		d.sourceRefs.every(
			(ref) => !body.includes(ref) && !body.includes(markdownPlainText(ref)),
		),
		"skill_provenance_in_body",
	);
	return body;
}
