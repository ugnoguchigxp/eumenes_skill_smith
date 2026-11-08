import { skillDeliveryPacket } from "./skill-delivery.js";
import { createApprovedSkillOperations } from "./approved-skills.js";
import type { ReuseBuild } from "./approved-skills.js";
import type { SkillDelivery } from "../contracts/approved-skills.js";
import { requestAuthorized } from "./authority.js";
import { renderSkillMarkdown, type SkillReply } from "./skill-markdown.js";
import {
	CONTRACT,
	authoritySchema,
	requestSchema,
} from "../contracts/schema.js";
import type { Ports, ExecutionContext } from "../contracts/ports.js";
import { resolveServiceLimits } from "../contracts/limits.js";
import type {
	Authority,
	Build,
	Executed,
	Outcome,
	Prepared,
	Reply,
	RequestRecord,
} from "../contracts/types.js";
import {
	buildContent,
	contentDigest,
	executeBuild,
	failureCode,
} from "./build.js";
import { resolveAssembly } from "./assembly.js";
import { bytes, digest, requireThat } from "./identity.js";
import { createResultOperations } from "./results.js";

export function createSkillSmith<Tx>(p: Ports<Tx>) {
	const repo = p.repository;
	const limits = resolveServiceLimits(p.limits);
	const assembly = resolveAssembly(p.assemblyMode ?? "baseline");
	function valid(tx: Tx, row: RequestRecord, auth: Authority) {
		return requestAuthorized(p, tx, row, auth, "build");
	}
	function update(tx: Tx, row: RequestRecord) {
		const rev = row.revision;
		row.revision++;
		repo.putRequest(tx, row, rev);
	}
	function finish(tx: Tx, row: RequestRecord, outcome: Outcome) {
		row.outcome = outcome;
		row.runToken = null;
		update(tx, row);
		repo.putDelivery(tx, {
			id: row.ref + ":result",
			requestRef: row.ref,
			scope: row.authority.scope,
			epoch: row.epoch,
			acknowledged: false,
		});
	}
	function usable(tx: Tx, b: Build, auth: Authority) {
		const origin = repo.request(tx, b.requestRef);
		const generatorOk = b.generator
			? b.generator.contractVersion === CONTRACT &&
				b.generator.instructions === assembly.instructionVersion
			: assembly.mode === "legacy";
		const presentationOk =
			assembly.mode === "legacy" ||
			(b.content.decision.localizedInstructions !== undefined &&
				b.content.decision.document !== undefined);
		return (
			!!origin &&
			valid(tx, origin, auth) &&
			!b.revoked &&
			!repo.blocked(tx, b.ref) &&
			b.scope === auth.scope &&
			b.expiresAt > p.now() &&
			generatorOk &&
			presentationOk &&
			(!b.publication || approved.current(tx, b, auth)) &&
			p.policy.current(tx, b.content.policy.version) &&
			p.registry.current(
				tx,
				auth,
				b.content.dependencies.filter((e) => !e.external).map((e) => e.version),
			)
		);
	}
	function reply(
		tx: Tx,
		row: RequestRecord,
		auth: Authority,
		validatedDigest?: string,
		enforceBudget = true,
	): Reply {
		if (!valid(tx, row, auth))
			return {
				contractVersion: CONTRACT,
				kind: "rejected",
				code: "permission_denied",
			};
		const base = { contractVersion: CONTRACT, requestRef: row.ref };
		if (row.outcome?.kind === "ready") {
			const build = repo.build(tx, row.outcome.buildRef);
			if (!build || !usable(tx, build, auth))
				return { ...base, kind: "rejected", code: "build_revoked" };
			// External bodies require asynchronous revalidation before distribution.
			if (
				build.content.dependencies.some((e) => e.external) &&
				validatedDigest !== build.digest
			)
				return {
					...base,
					kind: "unavailable",
					code: "external_validation_required",
				};
			const ready: Reply = { ...base, kind: "ready", build };
			return !enforceBudget || bytes(ready) <= row.request.limits.outputBytes
				? ready
				: { ...base, kind: "unavailable", code: "context_budget_exceeded" };
		}
		if (row.outcome) return { ...base, ...row.outcome };
		if (row.request.limits.deadlineAt <= p.now()) {
			return { ...base, kind: "expired", code: "deadline_exceeded" };
		}
		return {
			...base,
			kind: "pending",
			deadlineAt: row.request.limits.deadlineAt,
			retryAfterMs: limits.pendingRetryAfterMs,
		};
	}
	function submitInternal(
		tx: Tx,
		input: unknown,
		authority: Authority,
		reuse?: ReuseBuild,
	): Reply {
		const request = requestSchema.parse(input),
			auth = authoritySchema.parse(authority);
		requireThat(
			auth.permissions.includes("build") &&
				p.authority.valid(tx, auth, auth.sourceRefs),
			"permission_denied",
		);
		const inputDigest = digest({ request, authority: auth });
		const old = repo.requestByKey(tx, auth.scope, request.requestId);
		if (old) {
			requireThat(old.inputDigest === inputDigest, "request_conflict");
			return reply(tx, old, auth);
		}
		requireThat(
			request.limits.deadlineAt > p.now() &&
				request.limits.deadlineAt <= p.now() + limits.maxSubmitHorizonMs,
			"invalid_deadline",
		);
		if (request.prior?.requestRef) {
			const prior = repo.request(tx, request.prior.requestRef);
			requireThat(prior && valid(tx, prior, auth), "permission_denied");
		}
		const policy = p.policy.resolve(tx, request, auth);
		requireThat(
			digest(policy.version) === digest(request.environment.policy),
			"policy_mismatch",
		);
		const { deadlineAt: _deadlineAt, ...limitsWithoutDeadline } =
			request.limits;
		const key = digest({
			request: {
				...request,
				requestId: undefined,
				prior: undefined,
				limits: limitsWithoutDeadline,
			},
			scope: auth.scope,
			principal: auth.principal,
			epoch: auth.epoch,
			sourceRefs: auth.sourceRefs,
			instructions: assembly.instructionVersion,
			generator: { contractVersion: CONTRACT },
		});
		const row: RequestRecord = {
			ref: p.id(),
			request,
			authority: auth,
			key,
			inputDigest,
			epoch: 0,
			revision: 0,
			createdAt: p.now(),
			jobRef: null,
			waitingParent: auth.parentRef ?? null,
			runToken: null,
			outcome: null,
			usage: {
				modelCalls: 0,
				sourceCalls: 0,
				inputTokens: null,
				outputTokens: null,
				reasoningTokens: null,
				cachedInputTokens: null,
			},
		};
		const cached = request.prior?.buildRef
			? repo.build(tx, request.prior.buildRef)
			: repo.cached(tx, auth.scope, key);
		// External dependency builds may be cached; delivery still revalidates
		// via getValidated before a ready reply is returned to the client.
		if (reuse) {
			const content = {
				...structuredClone(reuse.template.content),
				task: request.task,
				environment: request.environment,
				audience: request.audience,
			};
			const build: Build = {
				...structuredClone(reuse.template),
				ref: p.id(),
				requestRef: row.ref,
				key,
				content,
				digest: contentDigest(content),
				createdAt: p.now(),
				expiresAt: reuse.expiresAt,
				usage: reuse.usage,
				publication: reuse.publication,
			};
			repo.putBuild(tx, build);
			repo.link(tx, build.ref, row.ref);
			repo.link(tx, build.ref, reuse.publication.ref);
			for (const e of content.dependencies) repo.link(tx, build.ref, e.ref);
			row.usage = reuse.usage;
			row.outcome = { kind: "ready", buildRef: build.ref };
		} else if (cached && cached.key === key && usable(tx, cached, auth))
			row.outcome = { kind: "ready", buildRef: cached.ref };
		else if (!row.waitingParent)
			row.jobRef = p.jobs.enqueue(tx, {
				requestRef: row.ref,
				epoch: row.epoch,
				deadlineAt: request.limits.deadlineAt,
			});
		repo.putRequest(tx, row, null);
		for (const ref of [
			...auth.sourceRefs,
			...request.task.references,
			...(request.prior?.buildRef ? [request.prior.buildRef] : []),
		])
			repo.link(tx, row.ref, ref);
		return reply(tx, row, auth);
	}
	function submit(tx: Tx, input: unknown, authority: Authority): Reply {
		return submitInternal(tx, input, authority);
	}
	function activate(
		tx: Tx,
		ref: string,
		auth: Authority,
		parentReleased: boolean,
	) {
		const row = repo.request(tx, ref);
		if (
			!row ||
			!valid(tx, row, auth) ||
			row.outcome ||
			!row.waitingParent ||
			!parentReleased
		)
			return false;
		if (row.request.limits.deadlineAt <= p.now()) {
			row.epoch++;
			finish(tx, row, { kind: "expired", code: "deadline_exceeded" });
			return false;
		}
		row.jobRef = p.jobs.enqueue(tx, {
			requestRef: ref,
			epoch: row.epoch,
			deadlineAt: row.request.limits.deadlineAt,
		});
		row.waitingParent = null;
		update(tx, row);
		return true;
	}
	function prepare(
		tx: Tx,
		ref: string,
		epoch: number,
		auth: Authority,
	): Prepared | null {
		const row = repo.request(tx, ref);
		if (
			!row ||
			!valid(tx, row, auth) ||
			row.outcome ||
			row.epoch !== epoch ||
			row.waitingParent
		)
			return null;
		if (row.request.limits.deadlineAt <= p.now()) {
			row.epoch++;
			finish(tx, row, { kind: "expired", code: "deadline_exceeded" });
			return null;
		}
		const policy = p.policy.resolve(tx, row.request, auth);
		if (digest(policy.version) !== digest(row.request.environment.policy)) {
			finish(tx, row, { kind: "rejected", code: "policy_revoked" });
			return null;
		}
		row.runToken = p.id();
		update(tx, row);
		return { record: structuredClone(row), runToken: row.runToken, policy };
	}
	function reserve(
		tx: Tx,
		s: Prepared,
		kind: "modelCalls" | "sourceCalls",
		auth: Authority,
	) {
		const row = repo.request(tx, s.record.ref);
		requireThat(
			row &&
				valid(tx, row, auth) &&
				!row.outcome &&
				row.epoch === s.record.epoch &&
				row.runToken === s.runToken,
			"stale_request",
		);
		requireThat(row.request.limits.deadlineAt > p.now(), "deadline_exceeded");
		requireThat(row.usage[kind] < row.request.limits[kind], "budget_exceeded");
		row.usage[kind]++;
		update(tx, row);
	}
	function reserveDelivery(
		tx: Tx,
		ref: string,
		auth: Authority,
		kind: "modelCalls" | "sourceCalls",
	) {
		const row = repo.request(tx, ref);
		requireThat(
			row && valid(tx, row, auth) && row.outcome?.kind === "ready",
			"permission_denied",
		);
		requireThat(
			kind === "sourceCalls" &&
				row.usage.sourceCalls < row.request.limits.sourceCalls,
			"budget_exceeded",
		);
		row.usage.sourceCalls++;
		update(tx, row);
	}

	function noteUsage(
		tx: Tx,
		s: Prepared,
		auth: Authority,
		observed: {
			inputTokens: number | null;
			outputTokens: number | null;
			reasoningTokens?: number | null;
			cachedInputTokens?: number | null;
		},
	) {
		const row = repo.request(tx, s.record.ref);
		if (
			!row ||
			!valid(tx, row, auth) ||
			row.outcome ||
			row.epoch !== s.record.epoch ||
			row.runToken !== s.runToken
		)
			return false;
		// Absolute observed totals from the in-flight executor; do not add again.
		row.usage.inputTokens = observed.inputTokens;
		row.usage.outputTokens = observed.outputTokens;
		if ("reasoningTokens" in observed)
			row.usage.reasoningTokens = observed.reasoningTokens ?? null;
		if ("cachedInputTokens" in observed)
			row.usage.cachedInputTokens = observed.cachedInputTokens ?? null;
		update(tx, row);
		return true;
	}
	function settle(tx: Tx, s: Prepared, result: Executed, auth: Authority) {
		const row = repo.request(tx, s.record.ref);
		if (
			!row ||
			!valid(tx, row, auth) ||
			row.outcome ||
			row.epoch !== s.record.epoch ||
			row.runToken !== s.runToken
		)
			return false;
		if (row.request.limits.deadlineAt <= p.now()) {
			row.epoch++;
			finish(tx, row, { kind: "expired", code: "deadline_exceeded" });
			return false;
		}
		if (!result.receipt || !p.inference.validReceipt(tx, result.receipt)) {
			finish(tx, row, { kind: "rejected", code: "receipt_revoked" });
			return false;
		}
		row.usage.inputTokens = result.tokens?.input ?? null;
		row.usage.outputTokens = result.tokens?.output ?? null;
		if (result.tokens) {
			if ("reasoningTokens" in result.tokens)
				row.usage.reasoningTokens = result.tokens.reasoningTokens ?? null;
			if ("cachedInputTokens" in result.tokens)
				row.usage.cachedInputTokens = result.tokens.cachedInputTokens ?? null;
		}
		if (result.decision.kind !== "ready") {
			finish(tx, row, result.decision);
			return true;
		}
		requireThat(
			p.registry.current(
				tx,
				auth,
				result.evidence
					.filter(
						(e) =>
							result.decision.kind === "ready" &&
							result.decision.sourceRefs.includes(e.ref) &&
							!e.external,
					)
					.map((e) => e.version),
			) && p.policy.current(tx, s.policy.version),
			"dependency_revoked",
		);
		const content = buildContent(s, result.decision, result.evidence);
		const build: Build = {
			ref: p.id(),
			requestRef: row.ref,
			scope: auth.scope,
			key: row.key,
			digest: contentDigest(content),
			content,
			createdAt: p.now(),
			expiresAt: p.now() + limits.buildTtlMs,
			usage: structuredClone(row.usage),
			revoked: false,
			generator: {
				instructions: assembly.instructionVersion,
				contractVersion: CONTRACT,
			},
		};
		if (
			bytes(
				row.request.delivery === "artifact"
					? skillDeliveryPacket(
							row.ref,
							build,
							renderSkillMarkdown(content, undefined, p.skillMarkdown),
						)
					: {
							contractVersion: CONTRACT,
							requestRef: row.ref,
							kind: "ready",
							build,
						},
			) > row.request.limits.outputBytes
		) {
			finish(tx, row, { kind: "unavailable", code: "context_budget_exceeded" });
			return true;
		}
		repo.putBuild(tx, build);
		repo.link(tx, build.ref, row.ref);
		for (const e of content.dependencies) repo.link(tx, build.ref, e.ref);
		finish(tx, row, { kind: "ready", buildRef: build.ref });
		return true;
	}
	function terminate(
		tx: Tx,
		ref: string,
		auth: Authority,
		code: string,
		kind: "unavailable" | "cancelled" = "unavailable",
	) {
		const row = repo.request(tx, ref);
		if (!row || !valid(tx, row, auth)) return false;
		if (row.outcome) return false;
		row.epoch++;
		if (row.jobRef) p.jobs.cancel(tx, row.jobRef);
		finish(tx, row, { kind, code });
		return true;
	}
	function get(tx: Tx, ref: string, auth: Authority): Reply {
		const row = repo.request(tx, ref);
		return row
			? reply(tx, row, auth)
			: {
					contractVersion: CONTRACT,
					kind: "rejected",
					code: "request_unavailable",
				};
	}
	async function getValidatedInternal(
		ref: string,
		auth: Authority,
		read: <T>(op: (tx: Tx) => T) => T,
		signal: AbortSignal,
		context?: ExecutionContext,
		enforceBudget = true,
	): Promise<Reply> {
		signal.throwIfAborted();
		const snapshot = read((tx) => {
			const row = repo.request(tx, ref);
			if (!row || !valid(tx, row, auth) || row.outcome?.kind !== "ready")
				return null;
			const build = repo.build(tx, row.outcome.buildRef);
			return build && usable(tx, build, auth) ? build : null;
		});
		if (!snapshot) return read((tx) => get(tx, ref, auth));
		const external = snapshot.content.dependencies.filter((e) => e.external);
		if (external.length) {
			const bounded = AbortSignal.any([
				signal,
				AbortSignal.timeout(limits.deliveryValidateTimeoutMs),
			]);
			try {
				requireThat(
					!(p.assemblyMode !== "legacy" && p.source?.meteredCalls) || context,
					"budget_context_required",
				);
				if (context && !p.source?.meteredCalls)
					await context.reserve("sourceCalls");
				if (
					!p.source ||
					!(await p.source.validate(
						external,
						bounded,
						context ? { ...context, signal: bounded } : undefined,
					))
				)
					return {
						contractVersion: CONTRACT,
						requestRef: ref,
						kind: "rejected",
						code: "source_revoked",
					};
				bounded.throwIfAborted();
			} catch {
				return {
					contractVersion: CONTRACT,
					requestRef: ref,
					kind: "unavailable",
					code: "source_unavailable",
				};
			}
		}
		return read((tx) => {
			const row = repo.request(tx, ref);
			return row
				? reply(tx, row, auth, snapshot.digest, enforceBudget)
				: {
						contractVersion: CONTRACT,
						kind: "rejected",
						code: "request_unavailable",
					};
		});
	}
	const getValidated = (
		ref: string,
		auth: Authority,
		read: <T>(op: (tx: Tx) => T) => T,
		signal: AbortSignal,
		context?: ExecutionContext,
	) => getValidatedInternal(ref, auth, read, signal, context);
	/** Single-copy public artifact. Internal audit remains behind getValidated authorization. */
	async function getSkillDelivery(
		ref: string,
		auth: Authority,
		read: <T>(op: (tx: Tx) => T) => T,
		signal: AbortSignal,
		context?: ExecutionContext,
	): Promise<SkillDelivery> {
		const result = await getValidatedInternal(
			ref,
			auth,
			read,
			signal,
			context,
			false,
		);
		if (result.kind !== "ready")
			return { ...result, contractVersion: "skillsmith.delivery.v1" };
		try {
			signal.throwIfAborted();
			const skill = result.build.publication
				? approved.artifact(read, result.build, auth)
				: renderSkillMarkdown(result.build.content, undefined, p.skillMarkdown);
			const packet = skillDeliveryPacket(ref, result.build, skill);
			return read((tx) => {
				const row = repo.request(tx, ref);
				requireThat(
					row && valid(tx, row, auth) && usable(tx, result.build, auth),
					"permission_denied",
				);
				requireThat(
					bytes(packet) <= row.request.limits.outputBytes,
					"context_budget_exceeded",
				);
				return packet;
			});
		} catch (error) {
			return {
				contractVersion: "skillsmith.delivery.v1",
				requestRef: ref,
				kind: "unavailable",
				code: failureCode(error),
			};
		}
	}
	/** Resolve the public audit reference without widening private-origin access. */
	async function getSkillAudit(
		buildRef: string,
		auth: Authority,
		read: <T>(op: (tx: Tx) => T) => T,
		signal: AbortSignal,
		context?: ExecutionContext,
		maxAuditBytes = 32768,
	): Promise<Reply> {
		requireThat(
			Number.isSafeInteger(maxAuditBytes) &&
				maxAuditBytes >= 256 &&
				maxAuditBytes <= 131072,
			"invalid_audit_limit",
		);
		const ref = read((tx) => {
			const b = repo.build(tx, buildRef);
			return b && usable(tx, b, auth) ? b.requestRef : null;
		});
		if (!ref)
			return {
				contractVersion: CONTRACT,
				kind: "rejected",
				code: "permission_denied",
			};
		const result = await getValidatedInternal(
			ref,
			auth,
			read,
			signal,
			context,
			false,
		);
		return bytes(result) <= maxAuditBytes
			? result
			: {
					contractVersion: CONTRACT,
					kind: "unavailable",
					requestRef: ref,
					code: "context_budget_exceeded",
				};
	}
	/** Final artifact boundary; legacy JSON transport remains unchanged. */
	async function getSkillValidated(
		ref: string,
		auth: Authority,
		read: <T>(op: (tx: Tx) => T) => T,
		signal: AbortSignal,
		context?: ExecutionContext,
	): Promise<SkillReply> {
		const result = await getValidated(ref, auth, read, signal, context);
		if (result.kind !== "ready") return result;
		let final: Extract<SkillReply, { kind: "ready" }>;
		try {
			final = {
				...result,
				skill: result.build.publication
					? approved.artifact(read, result.build, auth)
					: renderSkillMarkdown(
							result.build.content,
							undefined,
							p.skillMarkdown,
						),
			};
		} catch (error) {
			return {
				contractVersion: CONTRACT,
				requestRef: ref,
				kind: "unavailable",
				code: failureCode(error),
			};
		}

		return read((tx) => {
			const row = repo.request(tx, ref);
			if (!row || !valid(tx, row, auth) || !usable(tx, result.build, auth))
				return {
					contractVersion: CONTRACT,
					kind: "rejected",
					code: "permission_denied",
				};
			return bytes(final) <= row.request.limits.outputBytes
				? final
				: {
						contractVersion: CONTRACT,
						requestRef: ref,
						kind: "unavailable",
						code: "context_budget_exceeded",
					};
		});
	}
	function bindUse(
		tx: Tx,
		ref: string,
		executionRef: string,
		auth: Authority,
		target: import("../contracts/types.js").GuidanceRequest,
	) {
		const b = repo.build(tx, ref);
		requireThat(
			b &&
				usable(tx, b, auth) &&
				auth.permissions.includes("build") &&
				p.authority.valid(tx, auth, [executionRef]),
			"permission_denied",
		);
		requireThat(
			digest(b.content.task) === digest(target.task) &&
				digest(b.content.environment) === digest(target.environment) &&
				b.content.audience === target.audience,
			"application_mismatch",
		);
		repo.bindUse(tx, auth.scope, ref, executionRef);
	}
	function forget(tx: Tx, roots: string[], limit = 500) {
		// Revoke roots first: repository ancestry checks block the whole closure immediately.
		for (const ref of roots) repo.revokeBuild(tx, ref);
		const queue = [...roots],
			seen = new Set<string>();
		let count = 0;
		while (queue.length && count < limit) {
			const ref = queue.shift()!;
			if (seen.has(ref)) continue;
			seen.add(ref);
			queue.push(...repo.dependants(tx, ref));
			const row = repo.request(tx, ref);
			if (row?.jobRef) p.jobs.cancel(tx, row.jobRef);
			repo.erase(tx, ref);
			count++;
		}
		return {
			erased: count,
			pending: [...new Set(queue)].filter((r) => !seen.has(r)),
		};
	}
	const approved = createApprovedSkillOperations(
		p,
		usable,
		(tx, input, auth, reuse) => submitInternal(tx, input, auth, reuse),
	);
	return {
		...approved.operations,
		submitArtifact: (tx: Tx, input: unknown, authority: Authority) =>
			submitInternal(
				tx,
				{ ...requestSchema.parse(input), delivery: "artifact" },
				authority,
			),
		getSkillDelivery,
		getSkillAudit,
		submit,
		activate,
		prepare,
		reserve,
		settle,
		get,
		getValidated,
		getSkillValidated,
		bindUse,
		forget,
		execute: (s: Prepared, c: ExecutionContext) => executeBuild(p, s, c),
		cancel: (tx: Tx, ref: string, auth: Authority) =>
			terminate(tx, ref, auth, "user_cancelled", "cancelled"),
		reserveDelivery,
		noteUsage,
		fail: (
			tx: Tx,
			s: Prepared,
			auth: Authority,
			code: string,
			tokens?: {
				input: number | null;
				output: number | null;
				reasoningTokens?: number | null;
				cachedInputTokens?: number | null;
			},
		) => {
			const current = repo.request(tx, s.record.ref);
			if (!(
				current &&
				!current.outcome &&
				valid(tx, current, auth) &&
				current.epoch === s.record.epoch &&
				current.runToken === s.runToken
			))
				return false;
			if (tokens) {
				current.usage.inputTokens = tokens.input;
				current.usage.outputTokens = tokens.output;
				if ("reasoningTokens" in tokens)
					current.usage.reasoningTokens = tokens.reasoningTokens ?? null;
				if ("cachedInputTokens" in tokens)
					current.usage.cachedInputTokens = tokens.cachedInputTokens ?? null;
				update(tx, current);
			}
			return terminate(tx, s.record.ref, auth, code);
		},
		pending: (tx: Tx, limit = 100) => repo.openRequests(tx, limit),
		...createResultOperations(p, limits),
	};
}
