import { artifactDigest } from "../service/identity.js";
import { SKILL_RENDERER_VERSION } from "../service/skill-markdown.js";
import { expect, test } from "bun:test";
import { YAML } from "bun";
import { fixture, ready } from "./fixture.js";
import { bodyTail } from "../service/build.js";
import {
	renderSkillMarkdown,
	validateSkillMarkdown,
	skillName,
	defaultSkillName,
} from "../index.js";

async function finalReady(f: ReturnType<typeof fixture>) {
	const built = await ready(f);
	const delivered = await f.service.getSkillValidated(
		built.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	if (delivered.kind !== "ready") throw new Error("expected_final_ready");
	return { ...built, skill: delivered.skill };
}

function document(
	name = "valid-skill",
	description = "Does work. Use for this work.",
	body = "## Steps\n\n1. Check inputs.",
) {
	return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
}

test("ready delivery has a deterministic validated artifact without changing stored content", async () => {
	const f = fixture();
	const reply = await finalReady(f);
	const content = structuredClone(reply.build.content);
	const skill = renderSkillMarkdown(content);
	expect(reply.skill).toEqual(skill);
	expect(skill.path).toBe(`${skill.name}/SKILL.md`);
	expect(() => validateSkillMarkdown(skill.content, skill.name)).not.toThrow();
	expect(renderSkillMarkdown(content)).toEqual(skill);
	expect(content).toEqual(reply.build.content);
	if (!content.policy.alreadyPresent)
		expect(skill.content).toContain(content.policy.body);
	expect(skill.content).not.toContain(content.task.acceptance[0]!.text);
	expect(content.task.acceptance).toEqual(reply.build.content.task.acceptance);
	expect(skill.content).toContain(content.task.constraints[0]!.text);
	const cached = f.submit({ ...f.request, requestId: "new-request" });
	expect(cached.kind).toBe("ready");
	if (cached.kind === "ready") {
		const delivered = await f.service.getSkillValidated(
			cached.requestRef!,
			f.auth,
			f.read,
			new AbortController().signal,
		);
		expect(delivered.kind).toBe("ready");
		if (delivered.kind === "ready") expect(delivered.skill).toEqual(skill);
	}
	expect(f.modelCalls()).toBe(1);
});

test("reuse artifact embeds selected body even when sections is empty", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["Check source."],
		assumptions: [],
	});
	const reply = await finalReady(f);
	expect(reply.build.content.decision.sections).toEqual([]);
	expect(reply.skill.content).toContain(
		"資料の正本を確認し、差異の根拠を対応付ける。",
	);
	expect(reply.skill.content).not.toContain("skill:compare@1");
	expect(reply.build.content.decision.sourceRefs).toEqual(["skill:compare@1"]);
});

test("compose retains instruction order, provenance and verification", async () => {
	const reply = await finalReady(fixture());
	const text = reply.skill.content;
	const sections = reply.build.content.decision.sections;
	expect(text.indexOf(sections[0]!.body)).toBeLessThan(
		text.indexOf(sections[1]!.body),
	);
	expect(text).not.toContain("方針:");
	expect(reply.build.content.decision.strategy).toBe("compose");
	expect(text).toContain("## 確認");
	expect(text).toContain(reply.build.content.decision.verification[0]!);
});

test("adapt artifact contains patched source sections, not the replaced section", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "adapt",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [
			{
				sourceRef: "skill:compare@1",
				sectionId: "inspect",
				body: "NEW INSPECTION",
			},
		],
		requiredCapabilities: [],
		verification: ["Check patch."],
		assumptions: [],
	});
	const reply = await finalReady(f);
	expect(reply.skill.content).toContain("NEW INSPECTION");
	expect(reply.skill.content).toContain("差異と出所を対応付ける。");
	expect(reply.skill.content).not.toContain("資料の正本を確認する。");
});

test("provisional is explicitly unverified with assumptions and no invented source", async () => {
	const f = fixture();
	f.setEvidence([]);
	f.setDecision({
		kind: "ready",
		strategy: "provisional",
		sourceRefs: [],
		sections: [{ id: "explore", body: "Bounded exploration." }],
		patches: [],
		requiredCapabilities: [],
		verification: ["Run a small check."],
		assumptions: [
			{ text: "Simulator available", mandatory: false, resolved: false },
		],
	});
	const reply = await finalReady(f);
	expect(reply.skill.content).toContain("暫定・未検証");
	expect(reply.skill.content).not.toContain("出典なし");
	expect(reply.skill.content).toContain(
		"適用前に確認する: Simulator available\n",
	);
	expect(reply.skill.content).toContain("Run a small check.");
});

test("pending and needs_input keep the question and have no skill artifact", async () => {
	const f = fixture();
	f.setDecision({ kind: "needs_input", missing: ["Which repository?"] });
	const pending = f.submit();
	expect("skill" in pending).toBe(false);
	const work = await f.run(pending.requestRef!);
	work.settle();
	const result = await f.service.getSkillValidated(
		pending.requestRef!,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(result.kind).toBe("needs_input");
	if (result.kind === "needs_input")
		expect(result.missing).toEqual(["Which repository?"]);
	expect("skill" in result).toBe(false);
});

test("name generation is bounded, kebab-case, deterministic, distinguishes slug collisions", () => {
	for (const goal of [
		"日本語のみ",
		"UPPER !! Title",
		"a".repeat(800),
		"---",
		"x/y/../z",
	]) {
		const name = skillName(goal);
		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(skillName(goal)).toBe(name);
	}
	expect(skillName("a b")).not.toBe(skillName("a-b"));
});

test("YAML quoting handles newlines, delimiters, colons and quotes in goal", async () => {
	const reply = await finalReady(fixture());
	const content = structuredClone(reply.build.content);
	content.task.goal = '日本語: "quotes"\n---\nname: injected\nemoji 🧪';
	const skill = renderSkillMarkdown(content, "safe-name");
	const fields = YAML.parse(skill.content.split("\n---\n")[0]!.slice(4)) as {
		name: string;
		description: string;
	};
	expect(fields.name).toBe("safe-name");
	expect(fields.description).toContain(content.task.goal);
	content.task.goal = "a".repeat(2000);
	const bounded = renderSkillMarkdown(content);
	expect(() => validateSkillMarkdown(bounded.content)).not.toThrow();
});

for (const name of [
	"",
	"Upper",
	"-start",
	"end-",
	"two--hyphens",
	"../escape",
	"x".repeat(65),
]) {
	test(`reject invalid name ${JSON.stringify(name)}`, () => {
		expect(() => validateSkillMarkdown(document(name))).toThrow(
			"skill_name_invalid",
		);
	});
}

for (const [text, code] of [
	["plain markdown", "skill_frontmatter_missing"],
	["---\nname: [\n---\nbody", "skill_frontmatter_invalid"],
	["---\n- array\n---\nbody", "skill_frontmatter_invalid"],
	["---\nname: valid-name\n---\nbody", "skill_description_invalid"],
	[document("valid-name", ""), "skill_description_invalid"],
	[document("valid-name", "x".repeat(1025)), "skill_description_invalid"],
	[document("valid-name", "description", "  "), "skill_body_empty"],
	[
		document().replace("description:", "sourceRefs: [x]\ndescription:"),
		"skill_frontmatter_field_invalid",
	],
] as const) {
	test(`reject invalid format: ${code} ${text.length}`, () => {
		expect(() => validateSkillMarkdown(text)).toThrow(code);
	});
}

test("directory name must match, and CRLF frontmatter is accepted", () => {
	expect(() => validateSkillMarkdown(document(), "other-name")).toThrow(
		"skill_directory_mismatch",
	);
	expect(() =>
		validateSkillMarkdown(document().replaceAll("\n", "\r\n"), "valid-skill"),
	).not.toThrow();
});

test("explicit bad export name and empty assembled body fail closed", async () => {
	const reply = await finalReady(fixture());
	expect(() => renderSkillMarkdown(reply.build.content, "../escape")).toThrow(
		"skill_name_invalid",
	);
	expect(() =>
		renderSkillMarkdown({ ...reply.build.content, body: " " }),
	).toThrow("skill_body_empty");
});

test("final delivery respects unchanged output byte limit even when internal JSON fits", async () => {
	const measured = await ready(fixture());
	const f = fixture();
	f.request.limits.outputBytes =
		Buffer.byteLength(JSON.stringify(measured.reply)) + 128;
	const internal = await ready(f);
	const delivered = await f.service.getSkillValidated(
		internal.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(delivered.kind).toBe("unavailable");
	if (delivered.kind === "unavailable")
		expect(delivered.code).toBe("context_budget_exceeded");
	expect("skill" in delivered).toBe(false);
});

test("final delivery does not bypass revoked authority", async () => {
	const f = fixture();
	const internal = await ready(f);
	f.setValid(false);
	const result = await f.service.getSkillValidated(
		internal.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(result.kind).toBe("rejected");
	expect("skill" in result).toBe(false);
});

test("final delivery revalidates external sources before disclosing a skill", async () => {
	const f = fixture({ external: true });
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["external:1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["Check external source."],
		assumptions: [],
	});
	const internal = await ready(f);
	f.setSourceValid(false);
	const result = await f.service.getSkillValidated(
		internal.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(result.kind).toBe("rejected");
	if (result.kind === "rejected") expect(result.code).toBe("source_revoked");
	expect("skill" in result).toBe(false);
});

test("reuse renders through deterministic sourceMarkdown; envelope stays in internal build", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["Check source."],
		assumptions: [],
	});
	const reply = await finalReady(f);
	const source = "資料の正本を確認し、差異の根拠を対応付ける。";
	const envelope = JSON.stringify({
		contractVersion: "x.v1",
		trust: { trustClass: "untrusted" },
		item: { body: source },
		_fixture: { digest: "d" },
	});
	const content = structuredClone(reply.build.content);
	content.body = content.body.replace(source, envelope);
	const seen: string[] = [];
	const skill = renderSkillMarkdown(content, undefined, {
		sourceMarkdown: (body) => {
			seen.push(body);
			return (JSON.parse(body) as { item: { body: string } }).item.body;
		},
	});
	expect(seen).toEqual([envelope]);
	expect(skill.content).toContain(source);
	for (const s of ['{"contractVersion', "_fixture", "trustClass", '"trust"'])
		expect(skill.content).not.toContain(s);
	expect(skill.content).not.toContain("## 出典\n");
	expect(skill.content).not.toContain("skill:compare@1");
	expect(content.dependencies[0]!.title).toBe("比較");
	expect(skill.content).not.toContain("受入条件\n");
	expect(content.body).toContain(envelope);
	expect(() =>
		renderSkillMarkdown({ ...content, body: content.body + "x" }),
	).toThrow("skill_body_unrecognized");
});

test("compose and provisional never invoke sourceMarkdown", async () => {
	const f = fixture();
	const reply = await finalReady(f);
	expect(reply.build.content.decision.strategy).not.toBe("reuse");
	const skill = renderSkillMarkdown(reply.build.content, undefined, {
		sourceMarkdown: () => {
			throw new Error("must_not_call");
		},
	});
	expect(skill.content).toContain("## 手順\n");
});

test("template is Japanese: no English headings, notes or internal markers", async () => {
	const f = fixture();
	f.setEvidence([]);
	f.setDecision({
		kind: "ready",
		strategy: "provisional",
		sourceRefs: [],
		sections: [{ id: "explore", body: "探索する。" }],
		patches: [],
		requiredCapabilities: [],
		verification: ["小さく確かめる。"],
		assumptions: [{ text: "任意の前提", mandatory: false, resolved: false }],
	});
	const content = structuredClone((await finalReady(f)).build.content);
	const oldTail = bodyTail(content.task, content.decision).join("\n\n");
	content.decision.assumptions.push(
		{ text: "必須の前提", mandatory: true, resolved: false },
		{ text: "解決した前提", mandatory: true, resolved: true },
	);
	content.body =
		content.body.slice(0, content.body.length - oldTail.length) +
		bodyTail(content.task, content.decision).join("\n\n");
	const text = renderSkillMarkdown(content).content;
	for (const h of ["## 手順\n", "## 確認\n"]) expect(text).toContain(h);
	expect(text).toContain("適用前に確認する: 任意の前提\n");
	expect(text).toContain("適用前に確認する: 必須の前提");
	expect(text).toContain("適用前に確認する: 解決した前提");
	for (const s of [
		"mandatory",
		"resolved:",
		"Instructions",
		"Verification",
		"Sources",
		"Assumptions",
		"Strategy",
		"Provides",
		"Use when",
		"PROVISIONAL",
	])
		expect(text).not.toContain(s);
	expect(text).toContain('description: "未検証の操作を安全に探索');
});

test("reuse name derives from primary source title; others keep goal identity", async () => {
	const f = fixture();
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["Check source."],
		assumptions: [],
	});
	const content = structuredClone((await finalReady(f)).build.content);
	content.dependencies = content.dependencies.map((x) =>
		x.ref === "skill:compare@1"
			? { ...x, title: "Prefer Idiomatic Go Over Direct Translation" }
			: x,
	);
	const skill = renderSkillMarkdown(content);
	expect(skill.name).toBe("prefer-idiomatic-go-over-direct-translation");
	expect(defaultSkillName(content)).toBe(skill.name);
	expect(renderSkillMarkdown(content)).toEqual(skill);
	expect(skill.content).toContain(
		"この作業の手順を提供する。次の作業を頼まれたときに使う: ",
	);
	content.dependencies = content.dependencies.map((x) => ({
		...x,
		title: "比較",
	}));
	expect(defaultSkillName(content)).toBe(skillName(content.task.goal));
	content.dependencies = content.dependencies.map((x) => ({
		...x,
		title: "x".repeat(100),
	}));
	expect(defaultSkillName(content)).toBe("x".repeat(64));
	const composed = (await finalReady(fixture())).build.content;
	expect(defaultSkillName(composed)).toBe(skillName(composed.task.goal));
});

test("M6 FINAL artifact identity binds exact bytes, renderer and extractor", async () => {
	const { skill, build } = await finalReady(fixture());
	expect(skill.digest).toBe(artifactDigest(skill.content));
	expect(skill.rendererVersion).toBe(SKILL_RENDERER_VERSION);
	expect(skill.sourceExtractorVersion).toBe("none");
	const changed = structuredClone(build.content);
	changed.task.acceptance[0]!.text += " changed";
	changed.body = changed.body.replace(
		"差異と出所が説明されている",
		"差異と出所が説明されている changed",
	);
	expect(renderSkillMarkdown(changed).digest).toBe(skill.digest);
	expect(changed.task.acceptance[0]!.text).not.toBe(
		build.content.task.acceptance[0]!.text,
	);
	const functional = structuredClone(build.content);
	const oldTail = bodyTail(functional.task, functional.decision).join("\n\n");
	functional.decision.verification[0] += " 再確認する";
	functional.body =
		functional.body.slice(0, functional.body.length - oldTail.length) +
		bodyTail(functional.task, functional.decision).join("\n\n");
	expect(renderSkillMarkdown(functional).digest).not.toBe(skill.digest);
	expect(artifactDigest(skill.content + "\n")).not.toBe(skill.digest);
});

for (const field of [
	"license: 123",
	"compatibility: [bad]",
	"compatibility: " + "x".repeat(501),
	"compatibility: ''",
	"metadata: false",
	"metadata: [bad]",
	"metadata: {a: 1}",
	"metadata: {a: {nested: text}}",
	"allowed-tools: [Read]",
])
	test(`L2 rejects typed optional frontmatter: ${field.slice(0, 40)}`, () => {
		expect(() =>
			validateSkillMarkdown(
				document().replace("description:", field + "\ndescription:"),
			),
		).toThrow("skill_frontmatter_optional_invalid");
	});
test("L2 all supported optional frontmatter fields follow the pinned spec", () => {
	const text = document().replace(
		"description:",
		"license: MIT\ncompatibility: Bun 1.4.4\nmetadata: {author: 'test', version: '1'}\nallowed-tools: Read Bash(git:*)\ndescription:",
	);
	expect(() => validateSkillMarkdown(text)).not.toThrow();
});

for (const empty of [false, true])
	test(`L3 legacy source extractor failures become coded FINAL unavailable (${empty})`, async () => {
		const f = fixture();
		f.setDecision({
			kind: "ready",
			strategy: "reuse",
			sourceRefs: ["skill:compare@1"],
			sections: [],
			patches: [],
			requiredCapabilities: [],
			verification: ["確認"],
			assumptions: [],
		});
		const r = await ready(f);
		f.ports.skillMarkdown = {
			sourceMarkdown: () => {
				if (empty) return " ";
				throw new Error("PRIVATE_RAW_FAILURE");
			},
		};
		const final = await f.service.getSkillValidated(
			r.requestRef,
			f.auth,
			f.read,
			new AbortController().signal,
		);
		expect(final.kind).toBe("unavailable");
		if (final.kind === "unavailable")
			expect(final.code).toBe(
				empty ? "skill_source_body_empty" : "skill_source_extract_failed",
			);
		expect(JSON.stringify(final)).not.toContain("PRIVATE_RAW_FAILURE");
		expect("skill" in final).toBe(false);
	});
