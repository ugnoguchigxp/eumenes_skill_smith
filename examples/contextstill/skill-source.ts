import type { SkillMarkdownOptions } from "../../src/index.js";

/**
 * Deterministic field extraction from a ContextStill knowledge/episode document body
 * (as produced by source.get). Only usable text fields are rendered; envelope, trust,
 * handle, scores, timestamps and fixture metadata stay in the internal JSON build.
 * No model call, no keyword branching. Non-ContextStill bodies are returned unchanged.
 */
export function contextStillSourceMarkdown(body: string): string {
	let doc: unknown;
	try {
		doc = JSON.parse(body);
	} catch {
		return body;
	}
	if (
		!doc ||
		typeof doc !== "object" ||
		(doc as { contractVersion?: unknown }).contractVersion !==
			"contextstill-knowledge.v1"
	)
		return body;
	const item = (doc as { item?: Record<string, unknown> }).item ?? {};
	const str = (k: string) =>
		typeof item[k] === "string" ? (item[k] as string).trim() : "";
	const arr = (k: string) =>
		Array.isArray(item[k])
			? (item[k] as unknown[])
					.filter((x): x is string => typeof x === "string")
					.map((x) => x.trim())
					.filter(Boolean)
			: [];
	const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
	const out: string[] = [];
	const para = (heading: string, text: string) => {
		if (text) out.push(`### ${heading}\n\n${text}`);
	};
	const items = (heading: string, xs: string[], ordered = false) => {
		if (xs.length)
			out.push(
				`### ${heading}\n\n` +
					(ordered
						? xs.map((x, i) => `${i + 1}. ${x}`).join("\n")
						: bullets(xs)),
			);
	};
	const body0 = str("body");
	if (body0) out.push(body0);
	para("理由", str("rationale"));
	items("手順", arr("steps"), true);
	items("適用する場面", arr("appliesWhen"));
	items("適用しない場面", arr("notAppliesWhen"));
	items("例外", arr("exceptions"));
	const examples = Array.isArray(item.examples)
		? (item.examples as Record<string, unknown>[])
				.map((e) =>
					(
						[
							["situation", "状況"],
							["action", "行動"],
							["outcome", "結果"],
						] as const
					)
						.map(([k, label]) =>
							typeof e?.[k] === "string" && (e[k] as string).trim()
								? `${label}: ${(e[k] as string).trim()}`
								: "",
						)
						.filter(Boolean)
						.join("。"),
				)
				.filter(Boolean)
		: [];
	items("例", examples);
	// Episode documents.
	para("意図", str("intent"));
	para("判断", str("decision"));
	para("観察", str("observations"));
	para("行動", str("action"));
	para("結果", str("outcome"));
	para("教訓", str("lesson"));
	items("未解決の問い", arr("openQuestions"));
	if (!out.length) throw new Error("skill_source_body_empty");
	return out.join("\n\n");
}

export const contextStillSkillMarkdown: SkillMarkdownOptions = {
	sourceMarkdown: contextStillSourceMarkdown,
	sourceMarkdownVersion: "contextstill-source.v1",
};
