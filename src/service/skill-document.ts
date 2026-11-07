import type { Build } from "../contracts/types.js";
import { requireThat } from "./identity.js";
const STRATEGY: Record<string, string> = {
	reuse: "再利用",
	adapt: "改変",
	compose: "組み合わせ",
	provisional: "暫定",
};

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
/** A single code span: keep real machine IDs unchanged, encode delimiter/HTML bytes. */
const markdownReference = (ref: string) =>
	"`" +
	singleLineText(ref).replace(/[&<>`]/g, (c) => `&#${c.charCodeAt(0)};`) +
	"`";

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
	const titles = new Map(build.dependencies.map((x) => [x.ref, x.title]));
	const policy = build.policy.alreadyPresent ? "" : build.policy.body;
	const instructions = [policy, main].filter((t) => t.trim()).join("\n\n");
	requireThat(instructions.trim().length > 0, "skill_body_empty");
	const { acceptance, constraints } = build.task;
	checkLocalizedHost(build.task, d);
	const hostText = (id: string, original: string) => {
		const localized = d.localizedHost?.find((x) => x.id === id)?.text;
		return localized
			? `${markdownPlainText(localized)}（原文: ${markdownPlainText(original)}）`
			: markdownPlainText(original);
	};
	return [
		`# ${markdownPlainText(d.title ?? name)}`,
		d.strategy === "provisional"
			? "> 暫定・未検証: 探索のための指針であり、公式の Skill でも実行で確かめた Skill でもない。頼る前に前提を確かめ、下の確認を行うこと。"
			: "",
		"## 手順\n\n" + instructions,
		acceptance.length
			? "## 受け入れ条件\n\n" +
				list(
					acceptance.map(
						(c) =>
							`${markdownPlainText(c.id)}: ${hostText("acceptance:" + c.id, c.text)}`,
					),
				)
			: "",
		constraints.length
			? "## 制約\n\n" +
				list(
					constraints.map(
						(c) =>
							`${markdownPlainText(c.id)}: ${hostText("constraint:" + c.id, c.text)}`,
					),
				)
			: "",
		d.sourceReview?.flaggedItems.length
			? "## 要確認の出典記述\n\n" +
				list(
					d.sourceReview.flaggedItems.map(
						(x) =>
							`${markdownPlainText(x.claim)}: ${markdownPlainText(x.reason)}（${x.disposition === "removed" ? "手順から除外" : "要確認・未検証"}）`,
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
								? `${markdownPlainText(title)}（${markdownReference(ref)}）`
								: markdownReference(ref);
						}),
					)
				: "出典なし。この指針は検索で得た公式の Skill に基づいていない。"),
		"## 前提\n\n" +
			(d.assumptions.length
				? list(
						d.assumptions.map(
							(a, i) =>
								hostText("assumption:" + i, a.text) +
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
}
