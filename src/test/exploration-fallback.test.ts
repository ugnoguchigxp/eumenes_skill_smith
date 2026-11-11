import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createSkillSmith,
	skillDeliverySchema,
	skillSelectionSchema,
} from "../index.js";
import { fixture } from "./fixture.js";

const context = () => ({
	signal: new AbortController().signal,
	reserve: async () => {},
});
const choice = (value: unknown) => ({
	value,
	receipt: "exploration-receipt",
	inputTokens: 230,
	outputTokens: 20,
});

test("a bounded exploration decision binds the exact authored SKILL to each task", async () => {
	const f = fixture({ assemblyMode: "baseline" });
	f.ports.explorationFallback = true;
	const inputs: unknown[] = [];
	let language: "en" | "ja" = "en";
	f.ports.inference.complete = async (input) => {
		inputs.push(input);
		return choice({
			kind: "explore",
			language,
			assessment: "Read-only investigation can start.",
		});
	};
	const packets = [];
	for (const task of [
		{ goal: "Investigate pagination in a local file", language: "en" },
		{ goal: "配達する手順は英語にしてください。", language: "en" },
		{ goal: "ローカルの挙動を読み取り専用で確認する。", language: "ja" },
		{
			goal: "ローカルの帳票が意図どおりに表示されるか調べる。",
			language: "ja",
		},
	] as const) {
		language = task.language;
		const request = {
			...f.request,
			requestId: task.goal,
			delivery: "artifact" as const,
			task: { ...f.request.task, goal: task.goal },
		};
		const prepared = f.service.prepareSkillSelection(f.db, request, f.auth);
		expect(prepared.candidates).toEqual([]);
		const selected = await f.service.selectSkill(prepared, context());
		expect(skillSelectionSchema.safeParse(selected.decision).success).toBe(
			true,
		);
		expect(selected.usage).toMatchObject({
			modelCalls: 1,
			inputTokens: 230,
			outputTokens: 20,
		});
		const binding = f.write(() =>
			f.service.bindSkillSelection(f.db, prepared, selected, f.auth),
		);
		const reopened = createSkillSmith(f.ports);
		const packet = await reopened.getSkillDelivery(
			binding.requestRef!,
			f.auth,
			f.read,
			context().signal,
		);
		if (packet.kind !== "ready") throw Error(JSON.stringify(packet));
		expect(skillDeliverySchema.safeParse(packet).success).toBe(true);
		expect(packet.exploration).toBe(true);
		expect(packet.dependencyVersions).toEqual([]);
		const audit = await reopened.getSkillAudit(
			packet.auditRef,
			f.auth,
			f.read,
			context().signal,
		);
		if (audit.kind !== "ready") throw Error("audit_required");
		expect(audit.build.content.task).toEqual(request.task);
		expect(audit.build.content.decision.strategy).toBe("provisional");
		expect(audit.build.content.decision.language).toBe(task.language);
		packets.push(packet);
	}
	expect(packets[0]!.skill).toEqual(packets[1]!.skill);
	expect(packets[2]!.skill).toEqual(packets[3]!.skill);
	for (const [index, archive] of [
		[0, "exploration-template-2026-11-11/safe-task-exploration"],
		[2, "exploration-ja-2026-11-11/safe-task-exploration-ja"],
	] as const) {
		const path = new URL(
			`../../docs/quality/${archive}/SKILL.md`,
			import.meta.url,
		);
		expect(packets[index]!.skill.content).toBe(readFileSync(path, "utf8"));
	}
	expect(inputs).toHaveLength(4);
	const modelInputs = JSON.stringify(inputs);
	expect(modelInputs).not.toContain("Design one bounded experiment");
	expect(modelInputs).not.toContain("範囲を限定した実験を一つ設計する");
	const previous = await f.service.getSkillAudit(
		packets[0]!.auditRef,
		f.auth,
		f.read,
		context().signal,
	);
	if (previous.kind !== "ready") throw Error("audit_required");
	// Reopen an English build written with the selector version from c205160.
	const archivedBuild = f.ports.repository.build(f.db, packets[0]!.auditRef);
	if (!archivedBuild?.publication) throw Error("publication_required");
	archivedBuild.publication.selectorVersion =
		"61cbc900d70118b6ecb578b1c4d62077995df65bc012b1ad9c889b04bc722a29";
	f.write(() =>
		f.db
			.query("UPDATE knowledge_builds SET data_json=? WHERE ref=?")
			.run(JSON.stringify(archivedBuild), archivedBuild.ref),
	);
	const reopened = createSkillSmith(f.ports);
	expect(
		await reopened.getSkillDelivery(
			packets[0]!.requestRef,
			f.auth,
			f.read,
			context().signal,
		),
	).toEqual(packets[0]!);
	const pending = f.write(() =>
		f.service.submitArtifact(
			f.db,
			{
				...f.request,
				requestId: "fresh-generation",
				task: previous.build.content.task,
			},
			f.auth,
		),
	);
	expect(pending.kind).toBe("pending");
	f.setReceipts(false);
	expect(
		(
			await f.service.getSkillDelivery(
				packets[0]!.requestRef,
				f.auth,
				f.read,
				context().signal,
			)
		).kind,
	).toBe("rejected");
});

test("a miss stays unbound and a required inline policy suppresses the fixed SKILL", async () => {
	const f = fixture({ assemblyMode: "baseline" });
	f.ports.explorationFallback = true;
	let calls = 0;
	f.ports.inference.complete = async () => {
		calls++;
		return choice({ kind: "miss", reason: "The target is unknown." });
	};
	const prepared = f.service.prepareSkillSelection(f.db, f.request, f.auth);
	const result = await f.service.selectSkill(prepared, context());
	expect(result.decision.kind).toBe("miss");
	expect(() =>
		f.write(() => f.service.bindSkillSelection(f.db, prepared, result, f.auth)),
	).toThrow("selection_unavailable");
	const resolve = f.ports.policy.resolve;
	f.ports.policy.resolve = (...args) => ({
		...resolve(...args),
		alreadyPresent: false,
	});
	const withoutExploration = f.service.prepareSkillSelection(
		f.db,
		f.request,
		f.auth,
	);
	expect(withoutExploration.exploration).toBeUndefined();
	expect(
		(await f.service.selectSkill(withoutExploration, context())).decision.kind,
	).toBe("miss");
	expect(calls).toBe(1);
});
