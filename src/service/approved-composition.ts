import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import type { ApprovedSkill } from "../contracts/approved-skills.js";
import { buildSchema } from "../contracts/schema.js";
import type { Build, GuidanceRequest } from "../contracts/types.js";
import { artifactDigest, digest, requireThat } from "./identity.js";
import { markdownPlainText } from "./skill-document.js";
import {
	skillBundleDigest,
	skillName,
	SKILL_RENDERER_VERSION,
	validateSkillMarkdownFormat,
} from "./skill-markdown.js";

export const COMPOSITION_VERSION = "approved-composition.v1";

/** The approver attests each intact procedure as independently composable in this set. */
export function canCompose(parts: ApprovedSkill[]) {
	const group = parts[0]?.compositionGroup;
	const language = parts[0]?.template.content.decision.language;
	return (
		!!group &&
		!!language &&
		parts.every(({ compositionGroup, template, artifact }) => {
			const d = template.content.decision;
			return (
				compositionGroup === group &&
				!!template.generator &&
				artifact.rendererVersion === SKILL_RENDERER_VERSION &&
				artifact.sourceExtractorVersion === "none" &&
				d.language === language &&
				!!d.document &&
				d.strategy !== "provisional"
			);
		})
	);
}

export function assembleApprovedParts(
	request: Pick<GuidanceRequest, "task" | "environment" | "audience">,
	parts: ApprovedSkill[],
) {
	requireThat(
		parts.length >= 2 &&
			parts.length <= 3 &&
			new Set(parts.map((part) => part.ref)).size === parts.length &&
			canCompose(parts),
		"composition_incompatible",
	);
	const first = parts[0]!.template.content;
	const name = skillName(request.task.goal);
	const files = new Map<
		string,
		{ path: string; digest: string; content: string }
	>();
	const dependencies = new Map<
		string,
		Build["content"]["dependencies"][number]
	>();
	const members = parts.map((part) => {
		const a = part.artifact;
		const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(a.content);
		requireThat(match, "artifact_mismatch");
		const body = match[1]!.trim();
		// Definitions and local fragment links can retarget when Markdown documents join.
		const visit = (node: Nodes) => {
			requireThat(
				node.type !== "definition" &&
					node.type !== "linkReference" &&
					node.type !== "imageReference" &&
					!(
						(node.type === "link" || node.type === "image") &&
						node.url.startsWith("#")
					),
				"composition_incompatible",
			);
			if ("children" in node) for (const child of node.children) visit(child);
		};
		visit(fromMarkdown(body));
		for (const file of a.files) {
			const path = name + file.path.slice(a.name.length);
			requireThat(
				!files.has(path) || files.get(path)?.digest === file.digest,
				"composition_incompatible",
			);
			files.set(path, { ...file, path });
		}
		for (const dependency of part.template.content.dependencies) {
			const prior = dependencies.get(dependency.ref);
			requireThat(
				!prior ||
					(digest(prior.version) === digest(dependency.version) &&
						prior.external === dependency.external &&
						prior.scope === dependency.scope),
				"composition_incompatible",
			);
			dependencies.set(dependency.ref, dependency);
		}
		return body;
	});
	const title = parts
		.map((part) => part.template.content.decision.title)
		.join(" / ");
	const body = `# ${markdownPlainText(title)}\n\n${members.join("\n\n---\n\n")}`;
	const description = parts
		.map((p) => p.template.content.decision.description)
		.join(" / ")
		.slice(0, 1024)
		.trim();
	const markdown = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
	validateSkillMarkdownFormat(markdown, name);
	const main = { path: name + "/SKILL.md", digest: artifactDigest(markdown) };
	const resources = [...files.values()];
	requireThat(resources.length <= 8, "context_budget_exceeded");
	const artifact = {
		...main,
		name,
		content: markdown,
		files: resources,
		rendererVersion: COMPOSITION_VERSION,
		sourceExtractorVersion: "none",
		bundleDigest: skillBundleDigest(main, resources),
	};
	const decisions = parts.map((part) => part.template.content.decision);
	const content = buildSchema.shape.content.safeParse({
		task: request.task,
		environment: request.environment,
		audience: request.audience,
		contractVersion: first.contractVersion,
		body,
		dependencies: [...dependencies.values()],
		policy: first.policy,
		decision: {
			kind: "ready",
			strategy: "compose",
			sourceRefs: [...dependencies.keys()],
			sections: parts.map((part, i) => ({
				id: "part-" + (i + 1),
				body: part.applicability,
			})),
			patches: [],
			requiredCapabilities: [
				...new Set(decisions.flatMap((d) => d.requiredCapabilities)),
			],
			verification: [...new Set(decisions.flatMap((d) => d.verification))],
			assumptions: decisions.flatMap((d) => d.assumptions),
		},
	});
	requireThat(content.success, "context_budget_exceeded");
	return { artifact, content: content.data };
}
