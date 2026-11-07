import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
import { requestSchema, digest, INSTRUCTION_VERSION } from "../index.js";
import {
	buildInstructions,
	semanticReviewInstructions,
} from "../instructions/build.js";

test("a saved acceptance returns pending, then a complete body with unchanged conditions", async () => {
	const f = fixture(),
		r = await ready(f);
	expect(r.build.content.body).toContain(f.request.task.acceptance[0]!.text);
	expect(r.build.content.body).toContain(f.request.task.constraints[0]!.text);
	expect(r.build.content.decision.strategy).toBe("compose");
	expect(r.build.digest).toBe(digest(r.build.content));
	expect(r.build.usage.modelCalls).toBe(1);
	expect(f.modelCalls()).toBe(1);
	expect("body" in r.build.content.dependencies[0]!).toBe(false);
});
test("exact reuse needs no further inference", async () => {
	const f = fixture(),
		first = await ready(f);
	const second = f.submit({ ...f.request, requestId: "request:2" });
	expect(second.kind).toBe("ready");
	if (second.kind === "ready") expect(second.build.ref).toBe(first.build.ref);
	expect(f.modelCalls()).toBe(1);
});
test("a changed acceptance never hits the old build", async () => {
	const f = fixture();
	await ready(f);
	const r = f.submit({
		...f.request,
		requestId: "request:2",
		task: {
			...f.request.task,
			acceptance: [{ id: "new", text: "別の成果が必要" }],
		},
	});
	expect(r.kind).toBe("pending");
});
test("unknown work yields a provisional strategy through the injected LLM", async () => {
	const f = fixture();
	f.setEvidence([]);
	f.setDecision({
		kind: "ready",
		strategy: "provisional",
		sourceRefs: [],
		sections: [
			{
				id: "observe",
				body: "必要な情報を観測し、前提を検証して方針を更新する。",
			},
		],
		patches: [],
		requiredCapabilities: [],
		verification: ["受入条件の証拠を確認する。"],
		assumptions: [],
	});
	const r = await ready(f);
	expect(r.build.content.decision.strategy).toBe("provisional");
});
test("an unresolved mandatory assumption cannot become ready", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [
			{ text: "必須の許可が未確認", mandatory: true, resolved: false },
		],
	});
	const pending = f.submit();
	expect(pending.requestRef).toBeDefined();
	await expect(f.run(pending.requestRef!)).rejects.toThrow(
		"required_condition_missing",
	);
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_builds").get()).toEqual({
		n: 0,
	});
});
test("unoffered capability IDs and source references are refused", async () => {
	for (const missing of ["capability", "source"]) {
		const f = fixture();
		f.setDecision({
			kind: "ready",
			strategy: "reuse",
			sourceRefs: [missing === "source" ? "unknown" : "skill:compare@1"],
			sections: [],
			patches: [],
			requiredCapabilities: missing === "capability" ? ["not-offered"] : [],
			verification: ["確認"],
			assumptions: [],
		});
		const receipt = f.submit();
		await expect(f.run(receipt.requestRef!)).rejects.toThrow(
			missing === "source" ? "source_unavailable" : "capability_missing",
		);
	}
});
test("adaptation patches only exact section IDs", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "adapt",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [
			{
				sourceRef: "skill:compare@1",
				sectionId: "compare",
				body: "差異を反例も含めて確かめる。",
			},
		],
		requiredCapabilities: [],
		verification: ["根拠を確認"],
		assumptions: [],
	});
	const r = await ready(f);
	expect(r.build.content.body).toContain("資料の正本を確認する。");
	expect(r.build.content.body).toContain("反例も含めて");
});
test("a nonexistent section cannot be patched by approximate text matching", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "adapt",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [
			{ sourceRef: "skill:compare@1", sectionId: "similar", body: "差分" },
		],
		requiredCapabilities: [],
		verification: ["検証"],
		assumptions: [],
	});
	const r = f.submit();
	await expect(f.run(r.requestRef!)).rejects.toThrow("section_missing");
});
test("needs_input is terminal and an answer creates a new request", async () => {
	const f = fixture();
	f.setDecision({ kind: "needs_input", missing: ["対象となる資料の参照"] });
	const receipt = f.submit();
	const run = await f.run(receipt.requestRef!);
	run.settle();
	expect(f.service.get(f.db, receipt.requestRef!, f.auth).kind).toBe(
		"needs_input",
	);
	const next = f.submit({
		...f.request,
		requestId: "request:2",
		prior: { requestRef: receipt.requestRef! },
	});
	expect(next.kind).toBe("pending");
	expect(next.requestRef).not.toBe(receipt.requestRef);
});
test("malformed input and unsupported contracts are refused", () => {
	const f = fixture();
	expect(() =>
		requestSchema.parse({ ...f.request, contractVersion: "skillsmith.v0" }),
	).toThrow();
	expect(() =>
		f.submit({ ...f.request, task: { ...f.request.task, acceptance: [] } }),
	).toThrow();
});
test("malformed model output spends the bounded repair allowance", async () => {
	const f = fixture();
	f.setOutput({ not: "the schema" });
	const r = f.submit();
	await expect(f.run(r.requestRef!)).rejects.toThrow("invalid_model_output");
	expect(f.modelCalls()).toBe(2);
	expect(f.service.pending(f.db)[0]!.usage.modelCalls).toBe(2);
});
test("prompt material is isolated as data and a fabricated reference is rejected", async () => {
	const f = fixture();
	const original = f.ports.inference.complete;
	f.ports.inference.complete = async (input, signal) => {
		expect(input.system).toContain("未信頼");
		expect(JSON.stringify(input.data)).toContain("untrustedEvidence");
		expect(input.system).not.toContain("EXTERNAL_ATTACK_MARKER");
		return original(input, signal);
	};
	f.setEvidence([
		{
			ref: "skill:compare@1",
			version: { id: "x", version: "1", digest: "a", generation: 0 },
			title: "参考",
			body: "EXTERNAL_ATTACK_MARKER",
			status: "active",
			complete: true,
			external: false,
			scope: "shared",
		},
	]);
	await ready(f);
});
test("search cards are not treated as fetched bodies and reads obey the document limit", async () => {
	const f = fixture();
	let reads = 0;
	const original = f.ports.registry.read;
	f.ports.registry.read = async (...args) => {
		reads++;
		return original(...args);
	};
	await ready(f);
	expect(reads).toBe(1);
});
test("a revision change between discovery and read is rejected before inference", async () => {
	const f = fixture(),
		original = f.ports.registry.read;
	f.ports.registry.read = async (...args) => {
		const doc = await original(...args);
		return { ...doc, version: { ...doc.version, generation: 1 } };
	};
	const receipt = f.submit();
	await expect(f.run(receipt.requestRef!)).rejects.toThrow("source_revoked");
	expect(f.modelCalls()).toBe(0);
});
test("completed public replies satisfy the transport schema", async () => {
	const f = fixture(),
		r = await ready(f);
	const { replySchema } = await import("../index.js");
	expect(replySchema.parse(r.reply).kind).toBe("ready");
});
test("oversized input is refused before reserving a model call", async () => {
	const f = fixture(),
		r = f.submit({
			...f.request,
			limits: { ...f.request.limits, inputBytes: 1024 },
		});
	await expect(f.run(r.requestRef!)).rejects.toThrow("context_budget_exceeded");
	expect(f.modelCalls()).toBe(0);
	expect(f.service.pending(f.db)[0]!.usage.modelCalls).toBe(0);
});
test("the output limit includes the envelope and metadata, not only the body", async () => {
	const f = fixture(),
		first = await ready(f);
	const { canonical } = await import("../index.js");
	const limit =
		new TextEncoder().encode(canonical(first.build.content)).length + 1;
	const receipt = f.submit({
		...f.request,
		requestId: "request:2",
		limits: { ...f.request.limits, outputBytes: limit },
	});
	const work = await f.run(receipt.requestRef!);
	work.settle();
	expect(f.service.get(f.db, receipt.requestRef!, f.auth).kind).toBe(
		"unavailable",
	);
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_builds").get()).toEqual({
		n: 1,
	});
});

test("malformed evidence from registry.read is a source contract violation", async () => {
	const cases: {
		label: string;
		mutate: (doc: Record<string, unknown>) => unknown;
	}[] = [
		{
			label: "invalid_status",
			mutate: (doc) => ({ ...doc, status: "weird" }),
		},
		{
			label: "huge_body",
			mutate: (doc) => ({ ...doc, body: "x".repeat(40000) }),
		},
		{
			label: "duplicate_section_ids",
			mutate: (doc) => ({
				...doc,
				sections: [
					{ id: "same", body: "one" },
					{ id: "same", body: "two" },
				],
			}),
		},
	];
	for (const c of cases) {
		const f = fixture();
		const original = f.ports.registry.read;
		f.ports.registry.read = async (...args) => {
			const doc = await original(...args);
			return c.mutate(doc as unknown as Record<string, unknown>) as typeof doc;
		};
		const receipt = f.submit();
		await expect(f.run(receipt.requestRef!)).rejects.toThrow(
			"source_contract_violation",
		);
		expect(f.modelCalls()).toBe(0);
	}
});
test("well-formed evidence still builds after boundary validation", async () => {
	const f = fixture();
	const r = await ready(f);
	expect(r.build.content.dependencies[0]!.ref).toBe("skill:compare@1");
});

test("instruction version is the digest of the live instruction text", () => {
	expect(INSTRUCTION_VERSION).toBe(
		"build." + digest(buildInstructions + semanticReviewInstructions),
	);
	expect(INSTRUCTION_VERSION).not.toBe(
		"build." + digest(buildInstructions + "\n"),
	);
	expect(INSTRUCTION_VERSION).not.toBe("build.v3");
});

test("a structural decision failure can be repaired within the model call budget", async () => {
	const f = fixture();
	let calls = 0;
	const good = {
		kind: "ready" as const,
		strategy: "compose" as const,
		sourceRefs: ["skill:compare@1"],
		sections: [
			{ id: "start", body: "資料の正本と相違を確認する。" },
			{ id: "finish", body: "不確実な箇所を示し、報告を検証する。" },
		],
		patches: [],
		requiredCapabilities: ["read"],
		verification: ["差異の各項目が原資料へたどれるか確認する。"],
		assumptions: [],
	};
	const bad = {
		...good,
		requiredCapabilities: ["not-offered"],
	};
	f.ports.inference.complete = async (input) => {
		calls++;
		if (calls === 1) {
			expect("repair" in (input.data as object)).toBe(false);
			return {
				value: structuredClone(bad),
				receipt: "receipt",
				inputTokens: 1,
				outputTokens: 1,
			};
		}
		expect((input.data as { repair: { code: string } }).repair.code).toBe(
			"capability_missing",
		);
		return {
			value: structuredClone(good),
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		};
	};
	const r = await ready(f);
	expect(r.build.content.decision.requiredCapabilities).toEqual(["read"]);
	expect(calls).toBe(2);
});
test("structural repair stops at the model call limit and keeps the failure code", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [],
		requiredCapabilities: ["not-offered"],
		verification: ["確認"],
		assumptions: [],
	});
	const receipt = f.submit();
	await expect(f.run(receipt.requestRef!)).rejects.toThrow(
		"capability_missing",
	);
	expect(f.modelCalls()).toBe(2);
});

test("selected external evidence is validated in one source call", async () => {
	const f = fixture({ external: true });
	const base = {
		version: { id: "ext", version: "1", digest: "d", generation: 0 },
		title: "外部",
		body: "外部資料の手順。",
		status: "active" as const,
		complete: true,
		external: true,
		scope: "shared",
	};
	const docs = [
		{ ...base, ref: "external:1" },
		{ ...base, ref: "external:2", version: { ...base.version, id: "ext2" } },
	];
	f.ports.registry.search = async () => [];
	f.ports.source!.search = async () => ({
		cards: docs.map(({ body: _b, ...card }) => card),
		warnings: [],
		degraded: [],
		truncated: false,
	});
	f.ports.source!.get = async (ref) => docs.find((d) => d.ref === ref)!;
	let validateCalls = 0;
	let validatedRefs: string[] = [];
	f.ports.source!.validate = async (refs) => {
		validateCalls++;
		validatedRefs = refs.map((r) => r.ref);
		return true;
	};
	f.setDecision({
		kind: "ready",
		strategy: "compose",
		sourceRefs: ["external:1", "external:2"],
		sections: [
			{ id: "start", body: "外部資料を読み取る。" },
			{ id: "finish", body: "結果を検証する。" },
		],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [],
	});
	const receipt = f.submit();
	const work = await f.run(receipt.requestRef!);
	expect(validateCalls).toBe(1);
	expect(validatedRefs).toEqual(["external:1", "external:2"]);
	work.settle();
	const reply = await f.service.getValidated(
		receipt.requestRef!,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(reply.kind).toBe("ready");
	if (reply.kind === "ready")
		expect(reply.build.content.decision.sourceRefs).toEqual([
			"external:1",
			"external:2",
		]);
	// Delivery revalidates once more with the same batch.
	expect(validateCalls).toBe(2);
});

test("duplicate refs across local and external keep the first-seen card", async () => {
	const f = fixture({ external: true });
	const sharedRef = "skill:compare@1";
	const local = {
		ref: sharedRef,
		version: { id: "compare", version: "1", digest: "digest", generation: 0 },
		title: "比較",
		body: "ローカル本文。",
		sections: [{ id: "inspect", body: "確認する。" }],
		status: "active" as const,
		complete: true,
		external: false,
		scope: "shared",
	};
	f.setEvidence([local]);
	f.ports.source!.search = async () => ({
		cards: [
			{
				ref: sharedRef,
				version: { id: "ext", version: "9", digest: "other", generation: 0 },
				title: "外部同名",
				status: "active",
				complete: true,
				external: true,
				scope: "shared",
			},
		],
		warnings: [],
		degraded: [],
		truncated: false,
	});
	let gotExternal = false;
	f.ports.source!.get = async () => {
		gotExternal = true;
		throw new Error("should_not_read_duplicate_external");
	};
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: [sharedRef],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認"],
		assumptions: [],
	});
	const r = await ready(f);
	expect(gotExternal).toBe(false);
	expect(r.build.content.dependencies[0]!.external).toBe(false);
	expect(r.build.content.body).toContain("ローカル本文");
});

test("cached external builds revalidate and refuse revoked sources on delivery", async () => {
	const f = fixture({ external: true });
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["external:1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [],
	});
	const first = await ready(f);
	expect(f.modelCalls()).toBe(1);
	const second = f.submit({ ...f.request, requestId: "request:2" });
	expect(second.kind).toBe("unavailable");
	if (second.kind === "unavailable")
		expect(second.code).toBe("external_validation_required");
	expect(f.modelCalls()).toBe(1);
	const validated = await f.service.getValidated(
		second.requestRef!,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(validated.kind).toBe("ready");
	if (validated.kind === "ready")
		expect(validated.build.ref).toBe(first.build.ref);
	f.setSourceValid(false);
	const revoked = await f.service.getValidated(
		second.requestRef!,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(revoked.kind).toBe("rejected");
	if (revoked.kind === "rejected") expect(revoked.code).toBe("source_revoked");
});
