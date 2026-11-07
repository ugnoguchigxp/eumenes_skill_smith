import { expect, test } from "bun:test";
import { z } from "zod";
import { fixture, ready } from "./fixture.js";
import {
	decisionSchema,
	legacyModelTurnSchema,
	modelTurnSchema,
	compactReadySchema,
} from "../contracts/schema.js";
import {
	buildInstructions,
	semanticReviewInstructions,
	disclosureInstructions,
	INSTRUCTION_VERSION,
} from "../instructions/build.js";
import { digest } from "../service/identity.js";
import {
	renderSkillMarkdown,
	validateSkillMarkdown,
} from "../service/skill-markdown.js";

// Synthetic unit-test doubles only, never provider outputs/evaluation records.
const legacy = {
	kind: "ready" as const,
	strategy: "reuse" as const,
	sourceRefs: ["skill:compare@1"],
	sections: [],
	patches: [],
	requiredCapabilities: [],
	verification: ["差異の出所を照合する。"],
	assumptions: [],
};
const presentation = {
	name: "compare-source-differences",
	title: "原資料の相違を比較する",
	description:
		"原資料の相違と出所を対応付ける。資料の比較を依頼されたときに使う。",
	language: "ja",
	localizedInstructions: "正本を確認し、差異の根拠を対応付ける。",
};
const current = {
	...legacy,
	...presentation,
	sourceReview: { assessment: "test double", flaggedItems: [] },
	nonSourceAdditions: [],
};

function currentFixture() {
	const f = fixture({ assemblyMode: "baseline" });
	f.request.limits.modelCalls = 3;
	let calls = 0;
	const inputs: Parameters<typeof f.ports.inference.complete>[0][] = [];
	f.ports.inference.complete = async (input) => {
		inputs.push(input);
		calls++;
		return {
			value:
				input.system === semanticReviewInstructions
					? { approved: true, reason: "test double" }
					: calls === 1
						? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
						: current,
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		};
	};
	return { f, inputs };
}

test("current digest changes while initial disclosure payload stays archived", async () => {
	const { f, inputs } = currentFixture();
	const result = await ready(f);
	expect(INSTRUCTION_VERSION).toBe(
		"build." + digest(buildInstructions + semanticReviewInstructions),
	);
	expect(INSTRUCTION_VERSION).not.toBe(
		"build." + digest(disclosureInstructions),
	);
	expect(inputs[0]!.system).toBe(disclosureInstructions);
	expect(inputs[0]!.schema).toEqual(z.toJSONSchema(legacyModelTurnSchema));
	expect(inputs[1]!.system).toBe(buildInstructions);
	expect(inputs[1]!.schema).toEqual(z.toJSONSchema(modelTurnSchema));
	expect(result.build.generator?.instructions).toBe(INSTRUCTION_VERSION);
	expect(result.build.usage.modelCalls).toBe(3);
	expect(JSON.stringify(inputs)).not.toContain("expectedRefs");
	expect(JSON.stringify(inputs)).not.toContain("gold");
});

test("current ready fields are required, legacy storage allows only complete absence", () => {
	expect(decisionSchema.safeParse(legacy).success).toBe(true);
	expect(modelTurnSchema.safeParse(legacy).success).toBe(false);
	expect(modelTurnSchema.safeParse(current).success).toBe(true);
	expect(
		compactReadySchema.safeParse({ ...current, coverage: "sufficient" })
			.success,
	).toBe(true);
	expect(
		compactReadySchema.safeParse({ ...legacy, coverage: "sufficient" }).success,
	).toBe(false);
	for (const field of Object.keys(presentation)) {
		const missing = { ...current } as Record<string, unknown>;
		delete missing[field];
		expect(modelTurnSchema.safeParse(missing).success).toBe(false);
		expect(decisionSchema.safeParse(missing).success).toBe(false);
	}
});

test("name/title/description/language/instructions have structural bounds, not keyword language routing", () => {
	for (const name of ["Upper", "bad--slug", "../escape", "x".repeat(65)])
		expect(modelTurnSchema.safeParse({ ...current, name }).success).toBe(false);
	for (const field of [
		"title",
		"description",
		"language",
		"localizedInstructions",
	])
		expect(
			modelTurnSchema.safeParse({ ...current, [field]: " " }).success,
		).toBe(false);
	// No vocabulary detector claims to prove whether these words are Japanese.
	expect(
		modelTurnSchema.safeParse({ ...current, language: "en", title: "日本語" })
			.success,
	).toBe(true);
});

test("renderer uses builder title/description/body; source title is provenance only", async () => {
	const { f } = currentFixture();
	const result = await ready(f);
	const skill = renderSkillMarkdown(result.build.content, undefined, {
		sourceMarkdown: () => {
			throw new Error("new builds must not copy raw source envelopes");
		},
	});
	expect(skill.name).toBe(presentation.name);
	expect(skill.content).toContain(`# ${presentation.title}\n`);
	expect(skill.content).toContain(
		`description: ${JSON.stringify(presentation.description)}`,
	);
	expect(skill.content).toContain(presentation.localizedInstructions);
	expect(skill.content.split("## 出典")[0]).not.toContain("比較（");
	expect(skill.content).not.toContain("skill:compare@1");
	expect(result.build.content.dependencies[0]!.title).toBe("比較");
	expect(skill.content).not.toContain("contractVersion");
	expect(skill.name).not.toMatch(/[a-f0-9]{12}$/);
	validateSkillMarkdown(skill.content, presentation.name);
	const partial = structuredClone(result.build.content);
	delete partial.decision.language;
	expect(() => renderSkillMarkdown(partial)).toThrow(
		"incomplete_skill_presentation",
	);
});

test("legacy initial terminal ready cannot bypass current fields or the call budget", async () => {
	const f = fixture({ assemblyMode: "baseline" });
	f.setDecision(legacy);
	f.request.limits.modelCalls = 1;
	const pending = f.submit();
	await expect(f.run(pending.requestRef!)).rejects.toThrow(
		"invalid_model_output",
	);
	expect(f.modelCalls()).toBe(1);
});

test("current schema repair never falls back to legacy rendering", async () => {
	const { f } = currentFixture();
	let calls = 0;
	f.ports.inference.complete = async () => ({
		value:
			++calls === 1
				? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
				: legacy,
		receipt: "receipt",
		inputTokens: 1,
		outputTokens: 1,
	});
	const pending = f.submit();
	await expect(f.run(pending.requestRef!)).rejects.toThrow(
		"invalid_model_output",
	);
	expect(calls).toBe(f.request.limits.modelCalls);
});

test("current localized ready retains required-assumption, source-ref and capability checks", async () => {
	for (const invalid of [
		{
			...current,
			assumptions: [{ text: "必須条件", mandatory: true, resolved: false }],
		},
		{ ...current, sourceRefs: ["unknown"] },
		{ ...current, requiredCapabilities: ["not-offered"] },
	]) {
		const { f } = currentFixture();
		let calls = 0;
		f.ports.inference.complete = async () => ({
			value:
				++calls === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: invalid,
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		});
		const pending = f.submit();
		await expect(f.run(pending.requestRef!)).rejects.toThrow();
		expect(calls).toBe(f.request.limits.modelCalls);
	}
});

test("current localized artifacts still revalidate authority on delivery and cache by current version", async () => {
	const { f, inputs } = currentFixture();
	const result = await ready(f);
	const cached = f.submit({ ...f.request, requestId: "request:cached" });
	expect(cached.kind).toBe("ready");
	expect(inputs).toHaveLength(3);
	f.setValid(false);
	const reply = await f.service.getSkillValidated(
		result.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(reply.kind).toBe("rejected");
	expect("skill" in reply).toBe(false);
});

async function deliverCurrent(f: ReturnType<typeof fixture>) {
	const r = await ready(f);
	return f.service.getSkillValidated(
		r.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
}
test("H1 final artifact preserves host invariants, localized originals and provisional warning", async () => {
	const { f } = currentFixture();
	let call = 0;
	const d = {
		...current,
		strategy: "provisional",
		domainAnchors: [
			{ term: "対象の版", documentPointer: "対象の公式リファレンス" },
		],
		sourceRefs: [],
		sections: [{ id: "explore", body: "観測する" }],
		assumptions: [{ text: "任意前提", mandatory: false, resolved: false }],
		localizedInstructions: "隔離して観測する。",
		sourceReview: { assessment: "test double", flaggedItems: [] },
		nonSourceAdditions: [],
		localizedHost: [
			{ id: "acceptance:acceptance:1", text: "受入訳" },
			{ id: "constraint:constraint:1", text: "制約訳" },
			{ id: "verification:0", text: "確認訳" },
			{ id: "assumption:0", text: "前提訳" },
		],
	};
	f.ports.inference.complete = async (input) => ({
		value:
			input.system === semanticReviewInstructions
				? { approved: true, reason: "synthetic review" }
				: ++call === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: d,
		receipt: "receipt",
		inputTokens: 1,
		outputTokens: 1,
	});
	const result = await deliverCurrent(f);
	expect(result.kind).toBe("ready");
	if (result.kind === "ready")
		for (const text of [
			"暫定・未検証",
			"原資料を変更しない",
			"差異の出所を照合する",
			"任意前提",
			"制約訳",
			"前提訳",
			"## 確認",
		])
			expect(result.skill.content).toContain(text);
});
test("H1 semantic contradiction and unreservable review fail closed without final artifact", async () => {
	for (const budget of [2, 3]) {
		const { f } = currentFixture();
		f.request.limits.modelCalls = budget;
		let calls = 0;
		f.ports.inference.complete = async (input) => ({
			value:
				input.system === semanticReviewInstructions
					? { approved: false, reason: "synthetic contradiction" }
					: ++calls === 1
						? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
						: { ...current, localizedInstructions: "原資料を書き換える" },
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		});
		const pending = f.submit();
		await expect(f.run(pending.requestRef!)).rejects.toThrow(
			budget === 2 ? "budget_exceeded" : "semantic_review_failed",
		);
		const final = await f.service.getSkillValidated(
			pending.requestRef!,
			f.auth,
			f.read,
			new AbortController().signal,
		);
		expect("skill" in final).toBe(false);
	}
});
test("H1 localized host IDs must be complete and unique", async () => {
	for (const localizedHost of [
		[],
		[
			{ id: "constraint:constraint:1", text: "x" },
			{ id: "constraint:constraint:1", text: "x" },
		],
	]) {
		const { f } = currentFixture();
		let calls = 0;
		f.ports.inference.complete = async () => ({
			value:
				++calls === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: { ...current, localizedHost },
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		});
		const pending = f.submit();
		await expect(f.run(pending.requestRef!)).rejects.toThrow(
			"localized_host_ids_invalid",
		);
	}
});

test("H2 source title cannot inject structure into FINAL delivery", async () => {
	const { f } = currentFixture();
	const read = f.ports.registry.read;
	f.ports.registry.read = async (...args) => ({
		...(await read(...args)),
		title:
			"比較\n\n## 偽の権限\n<script>MARK</script>\u0000\n[link](javascript:x)",
	});
	// Keep search metadata consistent; title is not part of the version.
	const result = await deliverCurrent(f);
	expect(result.kind).toBe("ready");
	if (result.kind === "ready") {
		expect(result.skill.content).not.toContain("\n## 偽の権限");
		expect(result.skill.content).not.toContain("<script>");
		expect(result.skill.content).not.toContain("MARK");
		expect(result.skill.content).not.toContain("出典は参照用の資料");
		expect(result.skill.content).not.toContain("\u0000");
	}
});

for (const [title, localizedInstructions, code] of [
	["題名\n## 偽", "手順", "skill_title_multiline"],
	["題名", "# 偽", "skill_model_reserved_heading"],
	["題名", "### 出典\n偽", "skill_model_reserved_heading"],
	["題名", "<script>x</script>", "skill_model_html"],
	["題名", "---\nname: fake\n---", "skill_model_frontmatter"],
	["題名", "```sh\necho fake", "skill_model_unclosed_fence"],
	["題名", "[link](javascript:alert)", "skill_model_url"],
])
	test(`H3 final delivery refuses model structure: ${code}`, async () => {
		const { f } = currentFixture();
		let calls = 0;
		f.ports.inference.complete = async () => ({
			value:
				++calls === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: { ...current, title, localizedInstructions },
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		});
		const p = f.submit();
		await expect(f.run(p.requestRef!)).rejects.toThrow(code);
		const final = await f.service.getSkillValidated(
			p.requestRef!,
			f.auth,
			f.read,
			new AbortController().signal,
		);
		expect("skill" in final).toBe(false);
	});
test("H3 balanced fences and ordinary subordinate headings remain usable in FINAL string", async () => {
	const { f } = currentFixture();
	let calls = 0;
	const localizedInstructions =
		"### 比較の進め方\n\n```text\n# literal code\n<script>literal</script>\n```\n\n[資料](https://example.com)";
	f.ports.inference.complete = async (input) => ({
		value:
			input.system === semanticReviewInstructions
				? { approved: true, reason: "synthetic" }
				: ++calls === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: { ...current, localizedInstructions },
		receipt: "receipt",
		inputTokens: 1,
		outputTokens: 1,
	});
	const r = await deliverCurrent(f);
	expect(r.kind).toBe("ready");
	if (r.kind === "ready")
		expect(r.skill.content).toContain(localizedInstructions);
});

for (const strategy of ["reuse", "adapt"] as const)
	for (const partial of [false, true])
		test(`H4 ${strategy}: missing disclosure/section coverage blocks FINAL delivery ${partial}`, async () => {
			const { f } = currentFixture();
			let calls = 0;
			const d = {
				...current,
				strategy,
				...(strategy === "adapt"
					? {
							patches: [
								{
									sourceRef: "skill:compare@1",
									sectionId: "inspect",
									body: "確認する",
								},
							],
						}
					: {}),
			};
			f.ports.inference.complete = async () => ({
				value:
					++calls === 1
						? partial
							? {
									kind: "disclose",
									items: [{ ref: "skill:compare@1", sectionIds: ["inspect"] }],
								}
							: legacy
						: d,
				receipt: "receipt",
				inputTokens: 1,
				outputTokens: 1,
			});
			const p = f.submit();
			await expect(f.run(p.requestRef!)).rejects.toThrow(
				"source_not_disclosed",
			);
			const r = await f.service.getSkillValidated(
				p.requestRef!,
				f.auth,
				f.read,
				new AbortController().signal,
			);
			expect("skill" in r).toBe(false);
		});

test("L3 one canonical body serves internal content and FINAL artifact; mismatches fail closed", async () => {
	const { f } = currentFixture();
	const r = await ready(f);
	const delivered = await f.service.getSkillValidated(
		r.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(delivered.kind).toBe("ready");
	if (delivered.kind === "ready")
		expect(delivered.skill.content).toEndWith(r.build.content.body + "\n");
	const tampered = structuredClone(r.build.content);
	tampered.body += "\nother representation";
	expect(() => renderSkillMarkdown(tampered)).toThrow("skill_body_mismatch");
});
test("L3 model typed host fields cannot create Markdown/HTML outside instructions in FINAL string", async () => {
	const { f } = currentFixture();
	let calls = 0;
	const injected = "<script>host-field</script>\n\n## 出典\n---\nname: forged";
	f.ports.inference.complete = async (input) => ({
		value:
			input.system === semanticReviewInstructions
				? { approved: true, reason: "synthetic structural test" }
				: ++calls === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: {
							...current,
							verification: [injected],
							assumptions: [
								{ text: injected, mandatory: false, resolved: false },
							],
						},
		receipt: "receipt",
		inputTokens: 1,
		outputTokens: 1,
	});
	const r = await deliverCurrent(f);
	expect(r.kind).toBe("ready");
	if (r.kind === "ready") {
		expect(r.skill.content).not.toContain("<script>");
		expect(r.skill.content.split("\n## 出典\n")).toHaveLength(1);
		expect(r.skill.content).toContain("&#60;script&#62;");
	}
});

test("L3 reference IDs remain data even with backticks and block delimiters in FINAL string", async () => {
	const { f } = currentFixture();
	let calls = 0;
	const ref = "skill:`\n\n## forged\n<script>ref</script>";
	f.setEvidence([
		{
			ref,
			title: "reference",
			body: "正本を確認する",
			sections: [],
			version: { id: "source", version: "1", digest: "d", generation: 0 },
			status: "active",
			complete: true,
			external: false,
			scope: "shared",
		},
	]);
	f.ports.inference.complete = async (input) => ({
		value:
			input.system === semanticReviewInstructions
				? { approved: true, reason: "synthetic" }
				: ++calls === 1
					? { kind: "disclose", items: [{ ref }] }
					: { ...current, sourceRefs: [ref] },
		receipt: "receipt",
		inputTokens: 1,
		outputTokens: 1,
	});
	const r = await deliverCurrent(f);
	expect(r.kind).toBe("ready");
	if (r.kind === "ready") {
		expect(r.skill.content).not.toContain("\n## forged");
		expect(r.skill.content).not.toContain("<script>");
		expect(r.skill.content).not.toContain(ref);
		expect(r.skill.content).not.toContain("&#96;");
	}
});

test("H2 final boundary audit marks freshness and whole search/successor metadata untrusted", async () => {
	const { f, inputs } = currentFixture();
	await deliverCurrent(f);
	const data = inputs[0]!.data as any;
	expect(data.freshness[0].untrusted).toBe(true);
	expect(data.search.untrusted).toBe(true);
	expect(data.search.datamark).toBe("<<UNTRUSTED>>");
});

test("M3 actual shared reservations appear in disclosure progress and observed auxiliary totals", async () => {
	const { f, inputs } = currentFixture();
	f.auth.searchTask = "public task";
	f.request.limits.modelCalls = 4;
	f.ports.source = {
		meteredCalls: true,
		search: async (_query, _limit, _signal, context) => {
			await context!.reserve("modelCalls");
			await context!.noteUsage?.({
				callKind: "reformulation",
				inputTokens: 5,
				outputTokens: 7,
				reasoningTokens: 2,
				cachedInputTokens: 1,
			});
			return { cards: [], warnings: [], degraded: [], truncated: false };
		},
		get: async () => {
			throw new Error("not_used");
		},
		validate: async () => true,
	};
	const r = await ready(f);
	expect((inputs[0]!.data as any).disclosureProgress.modelCallsUsed).toBe(2);
	expect((inputs[1]!.data as any).disclosureProgress.modelCallsUsed).toBe(3);
	expect(r.build.usage).toMatchObject({
		modelCalls: 4,
		inputTokens: 8,
		outputTokens: 10,
		reasoningTokens: 2,
		cachedInputTokens: 1,
	});
});

for (const missing of ["generator", "presentation"] as const)
	test(`L3 current FINAL delivery rejects archived stored build without ${missing}`, async () => {
		const { f } = currentFixture();
		const r = await ready(f);
		const stored = structuredClone(r.build);
		if (missing === "generator") delete stored.generator;
		else stored.content.decision = legacy;
		f.db
			.query("UPDATE knowledge_builds SET data_json=? WHERE ref=?")
			.run(JSON.stringify(stored), stored.ref);
		const final = await f.service.getSkillValidated(
			r.requestRef,
			f.auth,
			f.read,
			new AbortController().signal,
		);
		expect(final.kind).toBe("rejected");
		if (final.kind === "rejected") expect(final.code).toBe("build_revoked");
		expect("skill" in final).toBe(false);
	});

test("v5 source review is mandatory for new terminal answers and host retains flagged claims in metadata only", async () => {
	const missing = { ...current } as Record<string, unknown>;
	delete missing.sourceReview;
	expect(modelTurnSchema.safeParse(missing).success).toBe(false);
	const { f } = currentFixture();
	let n = 0;
	f.ports.inference.complete = async (input) => ({
		value:
			input.system === semanticReviewInstructions
				? { approved: true, reason: "synthetic review" }
				: ++n === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: {
							...current,
							sourceReview: {
								assessment: "疑義あり",
								flaggedItems: [
									{
										claim: "# unsafe <tag>",
										reason: "版条件が不明",
										disposition: "needs_confirmation" as const,
									},
								],
							},
						},
		receipt: "test",
		inputTokens: 1,
		outputTokens: 1,
	});
	const r = await ready(f);
	const artifact = renderSkillMarkdown(r.build.content).content;
	expect(artifact).not.toContain("## 要確認の出典記述");
	expect(r.build.content.decision.sourceReview!.flaggedItems[0]!.claim).toBe(
		"# unsafe <tag>",
	);
	expect(artifact).not.toContain("要確認・未検証");
	expect(artifact).not.toContain("# unsafe <tag>");
	expect(r.build.content.decision.sourceReview!.flaggedItems[0]!.reason).toBe(
		"版条件が不明",
	);
});

test("v5 reader text has no internal IDs while evaluation metadata stays canonical", async () => {
	const { f } = currentFixture();
	f.request.task.acceptance = [
		{ id: "private-acceptance-id", text: "読者が結果を照合する" },
	];
	f.request.task.constraints = [
		{ id: "private-reader-id", text: "原資料を変更しない" },
		{
			id: "private-eval-id",
			text: "モックを変更しない",
			visibility: "evaluation",
		},
	];
	let n = 0;
	f.ports.inference.complete = async (input) => ({
		value:
			input.system === semanticReviewInstructions
				? { approved: true, reason: "synthetic" }
				: ++n === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: {
							...current,
							assumptions: [
								{
									text: "モック文字列一致",
									mandatory: false,
									resolved: false,
									visibility: "environment",
								},
								{ text: "読者向け前提", mandatory: false, resolved: false },
							],
						},
		receipt: "test",
		inputTokens: 1,
		outputTokens: 1,
	});
	const r = await ready(f);
	const text = renderSkillMarkdown(r.build.content).content;
	for (const x of [
		"原資料を変更しない",
		"読者向け前提",
		"差異の出所を照合する",
	])
		expect(text).toContain(x);
	for (const x of [
		"private-acceptance-id",
		"private-reader-id",
		"private-eval-id",
		"モックを変更しない",
		"モック文字列一致",
	])
		expect(text).not.toContain(x);
	expect(r.build.content.task.acceptance[0]!.text).toBe("読者が結果を照合する");
	expect(r.build.content.task.constraints[1]!.text).toBe("モックを変更しない");
	expect(r.build.content.decision.assumptions[0]!.text).toBe(
		"モック文字列一致",
	);
});

test("v5 composition requires structured interaction points and retains handling in metadata", async () => {
	for (const interactions of [
		undefined,
		[{ point: "条件の接点", handling: "先に型を決めてから処理する" }],
	]) {
		const { f } = currentFixture();
		let n = 0;
		f.ports.inference.complete = async (input) => ({
			value:
				input.system === semanticReviewInstructions
					? { approved: true, reason: "synthetic" }
					: ++n === 1
						? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
						: {
								...current,
								strategy: "compose",
								sections: [{ id: "merged", body: "比較する" }],
								localizedInstructions: interactions
									? interactions[0]!.handling
									: current.localizedInstructions,
								interactions,
							},
			receipt: "test",
			inputTokens: 1,
			outputTokens: 1,
		});
		if (!interactions) {
			const p = f.submit();
			await expect(f.run(p.requestRef!)).rejects.toThrow(
				"composition_interactions_missing",
			);
		} else {
			const r = await ready(f);
			const text = renderSkillMarkdown(r.build.content).content;
			expect(text).not.toContain("## 組み合わせの接点");
			expect(r.build.content.decision.interactions).toEqual(interactions);
			expect(text).toContain(interactions[0]!.handling);
		}
	}
});

test("v5 provisional needs explicit unverified domain anchors in metadata", async () => {
	for (const domainAnchors of [
		undefined,
		[
			{
				term: "分野固有の手がかり",
				documentPointer: "公式資料の該当節を調べる",
			},
		],
	]) {
		const { f } = currentFixture();
		let n = 0;
		f.ports.inference.complete = async (input) => ({
			value:
				input.system === semanticReviewInstructions
					? { approved: true, reason: "synthetic" }
					: ++n === 1
						? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
						: {
								...current,
								strategy: "provisional",
								sourceRefs: [],
								sections: [{ id: "explore", body: "観測する" }],
								localizedInstructions: domainAnchors
									? "未確認の探索語として" +
										domainAnchors[0]!.term +
										"を調べる。条件が合わなければ中止する。"
									: current.localizedInstructions,
								domainAnchors,
							},
			receipt: "test",
			inputTokens: 1,
			outputTokens: 1,
		});
		if (!domainAnchors) {
			const p = f.submit();
			await expect(f.run(p.requestRef!)).rejects.toThrow(
				"provisional_domain_anchors_missing",
			);
		} else {
			const r = await ready(f);
			const text = renderSkillMarkdown(r.build.content).content;
			expect(text).not.toContain("## 未確認の手がかり");
			expect(r.build.content.decision.domainAnchors).toEqual(domainAnchors);
			expect(text).toContain("暫定・未検証");
			expect(text).toContain(domainAnchors[0]!.term);
		}
	}
});

for (const strategy of ["reuse", "adapt", "compose", "provisional"] as const) {
	test(
		"v6 functional FINAL string only; canonical audit fields retained: " +
			strategy,
		async () => {
			const { f } = currentFixture();
			f.request.task.constraints = [
				{ id: "internal-reader-id", text: "対象の状態を変更しない" },
				{
					id: "internal-eval-id",
					text: "評価用DBは固定",
					visibility: "evaluation",
				},
			];
			let n = 0;
			const metadata = {
				practice: "先に小さな例で比較する",
				reason: "出典の原則を具体化する一般的な実務",
			};
			const d = {
				...current,
				strategy,
				sourceRefs: strategy === "provisional" ? [] : current.sourceRefs,
				sections:
					strategy === "reuse" ? [] : [{ id: "steps", body: "小さく比較する" }],
				nonSourceAdditions: [metadata],
				sourceReview: {
					assessment: "synthetic",
					flaggedItems: [
						{
							claim: "監査用の疑義",
							reason: "reader caution in instructions",
							disposition: "needs_confirmation" as const,
						},
					],
				},
				interactions:
					strategy === "compose"
						? [{ point: "前後の接続", handling: "順序を確かめる" }]
						: undefined,
				domainAnchors:
					strategy === "provisional"
						? [{ term: "探索語", documentPointer: "公式資料を調べる" }]
						: undefined,
				localizedInstructions:
					"小さな例を比較し、未確認の版条件を確かめる。条件が合わなければ中止する。",
				assumptions: [
					{ text: "対象の版を確認する", mandatory: false, resolved: false },
				],
			};
			f.ports.inference.complete = async (input) => ({
				value:
					input.system === semanticReviewInstructions
						? { approved: true, reason: "synthetic structure test" }
						: ++n === 1
							? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
							: d,
				receipt: "test",
				inputTokens: 1,
				outputTokens: 1,
			});
			const r = await ready(f);
			const text = renderSkillMarkdown(r.build.content).content;
			expect(text.match(/^## .+$/gm)).toEqual(["## 手順", "## 確認"]);
			const checks = text.split("## 確認")[1]!;
			for (const v of [
				"対象の状態を変更しない",
				"対象の版を確認する",
				"差異の出所を照合する",
			])
				expect(checks).toContain(v);
			for (const v of [
				"## 出典",
				"## 前提",
				"## 受け入れ条件",
				"## 制約",
				"## 要確認の出典記述",
				"## 組み合わせの接点",
				"## 未確認の手がかり",
				"skill:compare@1",
				"internal-reader-id",
				"internal-eval-id",
				"評価用DBは固定",
				"監査用の疑義",
				"読者向けの前提注記なし",
			])
				expect(text).not.toContain(v);
			expect(r.build.content.task.acceptance).toEqual(
				f.request.task.acceptance,
			);
			expect(r.build.content.task.constraints).toEqual(
				f.request.task.constraints,
			);
			expect(r.build.content.decision.nonSourceAdditions).toEqual([metadata]);
			expect(r.build.content.decision.sourceReview!.flaggedItems).toEqual(
				d.sourceReview.flaggedItems,
			);
			expect(r.build.content.decision.sourceRefs).toEqual(d.sourceRefs);
			if (strategy === "provisional")
				expect(text.indexOf("暫定・未検証")).toBeGreaterThan(
					text.indexOf("## 手順"),
				);
		},
	);
}
test("v6 new terminal answers must classify general knowledge additions as metadata", () => {
	expect(modelTurnSchema.safeParse(current).success).toBe(true);
	const missing = { ...current } as Record<string, unknown>;
	delete missing.nonSourceAdditions;
	expect(modelTurnSchema.safeParse(missing).success).toBe(false);
});
test("v6 source identifier in instructions is refused, never silently removed", async () => {
	const { f } = currentFixture();
	let n = 0;
	f.ports.inference.complete = async (input) => ({
		value:
			input.system === semanticReviewInstructions
				? { approved: true, reason: "synthetic" }
				: ++n === 1
					? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
					: { ...current, localizedInstructions: "skill:compare@1 を確認する" },
		receipt: "test",
		inputTokens: 1,
		outputTokens: 1,
	});
	const p = f.submit();
	await expect(f.run(p.requestRef!)).rejects.toThrow(
		"skill_provenance_in_body",
	);
});
