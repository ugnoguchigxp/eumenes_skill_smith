import { expect, test } from "bun:test";
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
	f.ports.inference.complete = async (input) => {
		inputs.push(input);
		return choice({
			kind: "explore",
			assessment: "Read-only investigation can start.",
		});
	};
	const packets = [];
	for (const goal of [
		"Investigate pagination in a local file",
		"Plan a read-only comparison",
	]) {
		const request = {
			...f.request,
			requestId: goal,
			delivery: "artifact" as const,
			task: { ...f.request.task, goal },
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
		packets.push(packet);
	}
	expect(packets[0]!.skill).toEqual(packets[1]!.skill);
	expect(inputs).toHaveLength(2);
	expect(JSON.stringify(inputs)).not.toContain("Design one bounded experiment");
	const previous = await f.service.getSkillAudit(
		packets[0]!.auditRef,
		f.auth,
		f.read,
		context().signal,
	);
	if (previous.kind !== "ready") throw Error("audit_required");
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
