import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { requireThat } from "./identity.js";

const reserved = new Set([
	"手順",
	"要確認の出典記述",
	"組み合わせの接点",
	"未確認の手がかり",
	"受け入れ条件",
	"受入条件",
	"制約",
	"確認",
	"前提",
	"出典",
	"acceptance",
	"constraints",
	"verification",
	"assumptions",
	"sources",
	"instructions and checks",
	"instructions",
	"steps",
]);
function nodeText(node: Nodes): string {
	if ("value" in node) return node.value;
	return "children" in node ? node.children.map(nodeText).join("") : "";
}
/** Current free-text grammar, not a semantic safety decision. */
export function validateModelMarkdown(title: string, body: string): void {
	requireThat(
		!/[\r\n\p{Cc}\p{Zl}\p{Zp}]/u.test(title),
		"skill_title_multiline",
	);
	const tree = fromMarkdown(body);
	const visit = (node: Nodes) => {
		requireThat(node.type !== "html", "skill_model_html");
		requireThat(node.type !== "thematicBreak", "skill_model_frontmatter");
		if (node.type === "heading")
			requireThat(
				node.depth >= 3 &&
					!reserved.has(nodeText(node).trim().normalize("NFKC").toLowerCase()),
				"skill_model_reserved_heading",
			);
		if (
			node.type === "link" ||
			node.type === "image" ||
			node.type === "definition"
		) {
			const url = node.url.trim();
			requireThat(
				!url.startsWith("//") &&
					(!/^[a-z][a-z0-9+.-]*:/i.test(url) ||
						/^(https?:|mailto:)/i.test(url)),
				"skill_model_url",
			);
		}
		if (node.type === "code") {
			const raw = body.slice(
				node.position!.start.offset,
				node.position!.end.offset,
			);
			const lines = raw.split(/\r?\n/);
			const opener = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!);
			if (opener) {
				const marker = opener[1]!;
				const closer = new RegExp(
					"^ {0,3}" + marker[0] + "{" + marker.length + ",}[ \\t]*$",
				);
				requireThat(
					lines.length > 1 && closer.test(lines.at(-1)!),
					"skill_model_unclosed_fence",
				);
			}
		}
		if ("children" in node) for (const child of node.children) visit(child);
	};
	visit(tree);
}
