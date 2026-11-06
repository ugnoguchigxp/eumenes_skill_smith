import { z } from "zod";
import {
	CONTRACT,
	decisionSchema,
	evidenceSchema,
	sourceSearchSchema,
} from "../contracts/schema.js";
import type { Ports, ExecutionContext } from "../contracts/ports.js";
import type {
	Build,
	Decision,
	Evidence,
	Executed,
	Prepared,
	ReadyDecision,
} from "../contracts/types.js";
import { buildInstructions } from "../instructions/build.js";
import { bytes, digest, requireThat, SkillSmithError } from "./identity.js";

function parseEvidence(raw: unknown): Evidence {
	const parsed = evidenceSchema.safeParse(raw);
	requireThat(parsed.success, "source_contract_violation");
	return parsed.data;
}

export function checkDecision(
	decision: ReadyDecision,
	evidence: Evidence[],
	p: Prepared,
) {
	const selected = decision.sourceRefs.map((ref) => {
		const e = evidence.find((e) => e.ref === ref);
		requireThat(e && e.status === "active" && e.complete, "source_unavailable");
		requireThat(
			e.scope === "shared" || e.scope === p.record.authority.scope,
			"scope_mismatch",
		);
		return e;
	});
	requireThat(
		decision.assumptions.every((a) => !a.mandatory || a.resolved),
		"required_condition_missing",
	);
	const capabilities = new Set(
		p.record.request.environment.capabilities.map((c) => c.id),
	);
	requireThat(
		decision.requiredCapabilities.every((c) => capabilities.has(c)),
		"capability_missing",
	);
	requireThat(
		new Set(decision.sections.map((s) => s.id)).size ===
			decision.sections.length,
		"duplicate_sections",
	);
	if (decision.strategy === "reuse")
		requireThat(
			selected.length === 1 &&
				!decision.sections.length &&
				!decision.patches.length,
			"invalid_reuse",
		);
	else if (decision.strategy === "adapt") {
		requireThat(selected.length === 1, "invalid_adaptation");
		requireThat(
			!!decision.sections.length !== !!decision.patches.length,
			"invalid_adaptation",
		);
	} else {
		requireThat(
			decision.sections.length > 0 && !decision.patches.length,
			"invalid_composition",
		);
		if (decision.strategy === "compose")
			requireThat(selected.length > 0, "source_missing");
	}
	if (decision.patches.length) {
		const patched = new Set<string>();
		for (const patch of decision.patches) {
			const e = selected.find((e) => e.ref === patch.sourceRef);
			const key = patch.sourceRef + ":" + patch.sectionId;
			requireThat(
				e?.sections?.some((s) => s.id === patch.sectionId) && !patched.has(key),
				"section_missing",
			);
			patched.add(key);
		}
	}
	return selected;
}
export function buildContent(
	p: Prepared,
	d: ReadyDecision,
	evidence: Evidence[],
): Build["content"] {
	const selected = checkDecision(d, evidence, p);
	let body: string;
	if (d.strategy === "reuse") body = selected[0]!.body;
	else if (d.patches.length)
		body = selected[0]!
			.sections!.map((s) => {
				const patch = d.patches.find((x) => x.sectionId === s.id);
				return patch?.body ?? s.body;
			})
			.join("\n\n");
	else body = d.sections.map((s) => s.body).join("\n\n");
	const { request } = p.record;
	body = [
		!p.policy.alreadyPresent ? p.policy.body : "",
		body,
		"受入条件\n" +
			request.task.acceptance.map((c) => c.id + ": " + c.text).join("\n"),
		request.task.constraints.length
			? "制約\n" +
				request.task.constraints.map((c) => c.id + ": " + c.text).join("\n")
			: "",
		"検証\n" + d.verification.join("\n"),
		d.assumptions.length
			? "前提\n" + d.assumptions.map((a) => a.text).join("\n")
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
	return {
		contractVersion: CONTRACT,
		task: request.task,
		audience: request.audience,
		environment: request.environment,
		body,
		decision: d,
		dependencies: selected.map(
			({ body: _body, sections: _sections, ...rest }) => rest,
		),
		policy: p.policy,
	};
}

export async function executeBuild<Tx>(
	ports: Ports<Tx>,
	p: Prepared,
	context: ExecutionContext,
): Promise<Executed> {
	const r = p.record,
		request = r.request,
		{ signal, reserve } = context;
	const checkpoint = () => {
		signal.throwIfAborted();
		requireThat(ports.now() < request.limits.deadlineAt, "deadline_exceeded");
	};
	const call = async <T>(f: () => Promise<T>) => {
		checkpoint();
		await reserve("sourceCalls");
		checkpoint();
		return f();
	};
	const local = await call(() =>
		ports.registry.search(
			request.task.goal,
			r.authority,
			request.limits.candidates,
			signal,
		),
	);
	const externalUsed = !!(ports.source && r.authority.searchTask);
	const reported = externalUsed
		? sourceSearchSchema.safeParse(
				await call(() =>
					ports.source!.search(
						r.authority.searchTask!,
						request.limits.candidates,
						signal,
					),
				),
			)
		: null;
	requireThat(!reported || reported.success, "source_contract_violation");
	const sourceSearch = reported?.data;
	const external = sourceSearch?.cards ?? [];
	requireThat(
		external.every((c) => c.external) &&
			(sourceSearch?.warnings ?? []).every((w) =>
				w.refs.every((ref) => external.some((c) => c.ref === ref)),
			),
		"source_contract_violation",
	);
	// Interleave by rank; first seen wins so a same-rank local card beats external.
	const combined: typeof local = [];
	const seenRefs = new Set<string>();
	for (let rank = 0; rank < Math.max(local.length, external.length); rank++) {
		for (const card of [local[rank], external[rank]]) {
			if (!card || seenRefs.has(card.ref)) continue;
			seenRefs.add(card.ref);
			combined.push(card);
		}
	}
	const candidates = combined.slice(0, request.limits.candidates);
	const evidence: Evidence[] = [];
	const read = (ref: string, external: boolean) =>
		external
			? (requireThat(ports.source, "source_unavailable"),
				ports.source.get(ref, signal))
			: ports.registry.read(ref, r.authority, signal);
	for (const card of candidates.slice(0, request.limits.documents)) {
		const document = parseEvidence(
			await call(() => read(card.ref, card.external)),
		);
		requireThat(
			document.ref === card.ref &&
				digest(document.version) === digest(card.version) &&
				document.external === card.external &&
				document.scope === card.scope,
			"source_revoked",
		);
		evidence.push(document);
	}
	// Follow published successors of superseded documents within the same
	// document and call budgets. Outcomes are structural facts for inference;
	// whether a successor fits the task is left to the model.
	const successors: {
		ref: string;
		successor: string;
		outcome: "fetched" | "unavailable" | "cycle" | "limit";
	}[] = [];
	const seen = new Set(evidence.map((e) => e.ref));
	for (let i = 0; i < evidence.length; i++) {
		const e = evidence[i]!;
		if (e.status !== "superseded" || !e.supersededBy) continue;
		const successor = e.supersededBy;
		if (seen.has(successor)) {
			successors.push({ ref: e.ref, successor, outcome: "cycle" });
			continue;
		}
		if (evidence.length >= request.limits.documents) {
			successors.push({ ref: e.ref, successor, outcome: "limit" });
			continue;
		}
		seen.add(successor);
		checkpoint();
		await reserve("sourceCalls");
		checkpoint();
		let next: Evidence | null = null;
		try {
			next = parseEvidence(await read(successor, e.external));
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof SkillSmithError) throw error;
		}
		if (
			next &&
			next.ref === successor &&
			next.external === e.external &&
			(next.scope === "shared" || next.scope === r.authority.scope)
		) {
			evidence.push(next);
			successors.push({ ref: e.ref, successor, outcome: "fetched" });
		} else successors.push({ ref: e.ref, successor, outcome: "unavailable" });
	}
	const candidateCards = candidates.map((e) => ({
		ref: e.ref,
		version: e.version,
		title: e.title,
		status: e.status,
		complete: e.complete,
		external: e.external,
		scope: e.scope,
	}));
	const data = {
		task: request.task,
		environment: request.environment,
		audience: request.audience,
		policy: p.policy,
		candidateCards,
		untrustedEvidence: evidence,
		search: {
			externalUsed,
			...(successors.length ? { successors } : {}),
			// Source-reported, untrusted. Only structure is checked; meaning is left to inference.
			...(sourceSearch
				? {
						external: {
							warnings: sourceSearch.warnings.filter((w) =>
								w.refs.every((ref) => candidates.some((c) => c.ref === ref)),
							),
							omittedWarnings: sourceSearch.warnings.filter(
								(w) =>
									!w.refs.every((ref) => candidates.some((c) => c.ref === ref)),
							).length,
							degraded: sourceSearch.degraded,
							truncated: sourceSearch.truncated,
						},
					}
				: {}),
		},
	};
	requireThat(
		bytes(data) + new TextEncoder().encode(buildInstructions).length <
			request.limits.inputBytes,
		"context_budget_exceeded",
	);
	let decision: Decision | undefined, receipt: string | undefined;
	const tokens = { input: 0 as number | null, output: 0 as number | null };
	let repair: { code: string; instruction: string } | undefined;
	let lastFailure = "invalid_model_output";
	for (let attempt = 0; attempt < request.limits.modelCalls; attempt++) {
		checkpoint();
		const modelInput = {
			system: buildInstructions,
			data: repair ? { ...data, repair } : data,
			schema: z.toJSONSchema(decisionSchema),
			deadlineAt: request.limits.deadlineAt,
			maxOutputTokens: request.limits.outputTokens,
			requestRef: r.ref,
		};
		requireThat(
			bytes(modelInput) <= request.limits.inputBytes,
			"context_budget_exceeded",
		);
		await reserve("modelCalls");
		checkpoint();
		const answer = await ports.inference.complete(modelInput, signal);
		receipt = answer.receipt;
		tokens.input =
			tokens.input === null || answer.inputTokens === null
				? null
				: tokens.input + answer.inputTokens;
		tokens.output =
			tokens.output === null || answer.outputTokens === null
				? null
				: tokens.output + answer.outputTokens;
		const parsed = decisionSchema.safeParse(answer.value);
		if (!parsed.success) {
			lastFailure = "invalid_model_output";
			repair = {
				code: "invalid_output",
				instruction:
					"前回の出力は採用されていない。元の目的・制約を保ちschemaに従って返す。",
			};
			continue;
		}
		const candidate = parsed.data;
		if (candidate.kind === "ready") {
			try {
				checkDecision(candidate, evidence, p);
				requireThat(
					bytes(buildContent(p, candidate, evidence)) <=
						request.limits.outputBytes,
					"context_budget_exceeded",
				);
			} catch (error) {
				if (
					!(error instanceof SkillSmithError) ||
					error.code === "context_budget_exceeded"
				)
					throw error;
				lastFailure = error.code;
				repair = {
					code: error.code,
					instruction:
						"前回の出力は構造検査で拒否された（" +
						error.code +
						"）。元の目的・制約を保ちschemaに従い、この違反を解消して返す。",
				};
				continue;
			}
		}
		decision = candidate;
		break;
	}
	checkpoint();
	requireThat(decision, lastFailure);
	if (decision.kind === "ready") {
		const selected = evidence.filter(
			(e) => decision.sourceRefs.includes(e.ref) && e.external,
		);
		if (selected.length)
			requireThat(
				ports.source &&
					(await call(() => ports.source!.validate(selected, signal))),
				"source_revoked",
			);
	}
	checkpoint();
	return { decision, evidence, receipt, tokens };
}
export function failureCode(error: unknown) {
	if (error instanceof SkillSmithError) return error.code;
	return "build_failed";
}
export const contentDigest = (content: Build["content"]) => digest(content);
