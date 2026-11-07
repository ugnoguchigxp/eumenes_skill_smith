import type { Build, ReadyDecision, Evidence } from "../contracts/types.js";
import { requireThat } from "./identity.js";
/** Archived audit tail for legacy execution decoding; never rendered as v6 SKILL sections. */
export function bodyTail(
	task: Build["content"]["task"],
	d: Pick<ReadyDecision, "verification" | "assumptions">,
): string[] {
	return [
		"受入条件\n" + task.acceptance.map((c) => c.id + ": " + c.text).join("\n"),
		task.constraints.length
			? "制約\n" + task.constraints.map((c) => c.id + ": " + c.text).join("\n")
			: "",
		"検証\n" + d.verification.join("\n"),
		d.assumptions.length
			? "前提\n" + d.assumptions.map((a) => a.text).join("\n")
			: "",
	].filter(Boolean);
}

/** Archived execution JSON representation only; never used by current document assembly. */
export function legacyExecutionBody(
	task: Build["content"]["task"],
	policy: Build["content"]["policy"],
	d: ReadyDecision,
	selected: Evidence[],
): string {
	let main: string;
	if (d.strategy === "reuse") main = selected[0]!.body;
	else if (d.patches.length)
		main = selected[0]!
			.sections!.map(
				(s) => d.patches.find((p) => p.sectionId === s.id)?.body ?? s.body,
			)
			.join("\n\n");
	else main = d.sections.map((s) => s.body).join("\n\n");
	return [policy.alreadyPresent ? "" : policy.body, main, ...bodyTail(task, d)]
		.filter(Boolean)
		.join("\n\n");
}
/** Strict decoding for an explicit legacy stored representation. */
export function legacyMainInstructions(build: Build["content"]): string {
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
