import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
import {
	createSkillSmith,
	skillDeliverySchema,
	type ApprovedSkill,
} from "../index.js";
import { sqliteApprovedSkills } from "../sqlite/index.js";
import { semanticReviewInstructions } from "../instructions/build.js";
import { compositionReviewInstructions } from "../instructions/selection.js";

const signal = () => new AbortController().signal;
const answer = (value: unknown) => ({
	value,
	receipt: "receipt",
	inputTokens: 11,
	outputTokens: 7,
});

async function approvedPair(fileCollision = false) {
	const f = fixture({ assemblyMode: "baseline" });
	const approvals = new Set<string>();
	let compositionAllowed = true;
	const store = sqliteApprovedSkills({
		authorizePublication: (_tx, _auth, r) => !!approvals.add(r.digest),
		approvalCurrent: (_tx, r) => approvals.has(r.digest),
		compositionCurrent: () => compositionAllowed,
	});
	f.ports.approvedSkills = store;
	f.request.limits.modelCalls = 3;
	f.request.limits.outputBytes = 32768;
	const parts: ApprovedSkill[] = [];
	for (const name of ["observe", "compare"]) {
		f.request.requestId = name;
		f.request.task.goal = name + " source records";
		let turns = 0;
		f.ports.inference.complete = async ({ system }) =>
			answer(
				system === semanticReviewInstructions
					? { approved: true, reason: "fixture" }
					: turns++ === 0
						? { kind: "disclose", items: [{ ref: "skill:compare@1" }] }
						: {
								kind: "ready",
								strategy: "reuse",
								sourceRefs: ["skill:compare@1"],
								sections: [],
								patches: [],
								requiredCapabilities: ["read"],
								verification: [
									name + " only after verifying the record scope.",
								],
								assumptions: [],
								name,
								title: name,
								description: name + " source records.",
								language: "en",
								localizedInstructions:
									"1. Open the approved records for " +
									name +
									". Stop if a record is inaccessible.",
								document: {
									sections: [
										{
											kind: "principles",
											heading: "Principles",
											body: "Preserve the record.",
										},
										{ kind: "workflow", heading: "Workflow" },
										{ kind: "completion", heading: "Checks" },
									],
									resourceHeading: "Examples",
									references: [
										{
											path:
												"references/" +
												(fileCollision ? "example" : name) +
												".md",
											title: name + " example",
											content: name + " fixture",
										},
									],
								},
								sourceReview: { assessment: "fixture", flaggedItems: [] },
								nonSourceAdditions: [],
							},
			);
		const built = await ready(f);
		const result = f.write(() =>
			f.service.publishSkill(
				f.db,
				{
					buildRef: built.build.ref,
					applicability: name + " scoped source records.",
					approvalRef: "approval:" + name,
					compositionGroup: "read-only-records",
				},
				f.auth,
			),
		);
		parts.push(store.get(f.db, result.ref)!);
	}
	const request = {
		...f.request,
		requestId: "new",
		delivery: "artifact" as const,
		task: { ...f.request.task, goal: "Observe and compare source records" },
	};
	f.ports.inference.complete = async ({ system, data }) =>
		answer(
			system === compositionReviewInstructions
				? {
						approved: true,
						checks: [
							{
								id: "acceptance:1",
								passage: (
									data as { passages: { index: number; text: string }[] }
								).passages.find((p) =>
									p.text.includes("approved records for observe"),
								)!.index,
							},
						],
					}
				: {
						kind: "composed",
						refs: parts.map((p) => p.ref),
						assessment: "Both steps fit.",
					},
		);
	return {
		f,
		approvals,
		parts,
		request,
		setCompositionAllowed: (value: boolean) => {
			compositionAllowed = value;
		},
	};
}

test("an approved match keeps its exact artifact with the exploration fallback offered", async () => {
	const { f, parts, request } = await approvedPair();
	const service = createSkillSmith({ ...f.ports, explorationFallback: true });
	f.ports.inference.complete = async () =>
		answer({
			kind: "selected",
			ref: parts[0]!.ref,
			assessment: "This approved procedure fits.",
		});
	const prepared = service.prepareSkillSelection(f.db, request, f.auth);
	expect(prepared.exploration).toBe(true);
	expect(prepared.candidates).toHaveLength(2);
	const selected = await service.selectSkill(prepared, {
		signal: signal(),
		reserve: async () => {},
	});
	const bound = f.write(() =>
		service.bindSkillSelection(f.db, prepared, selected, f.auth),
	);
	const packet = await service.getSkillDelivery(
		bound.requestRef!,
		f.auth,
		f.read,
		signal(),
	);
	if (packet.kind !== "ready") throw Error(JSON.stringify(packet));
	expect(packet.skill).toEqual(parts[0]!.artifact);
	expect(packet.exploration).toBeUndefined();
});

test("ordered approved parts deliver intact bodies, examples and audit under a compatible generator", async () => {
	const { f, approvals, parts, request, setCompositionAllowed } =
		await approvedPair();
	const prior = f.service.prepareSkillSelection(f.db, request, f.auth);
	expect(prior.candidates).toHaveLength(2);
	const old = f.ports.inference.complete;
	f.ports.inference.complete = async () =>
		answer({
			kind: "selected",
			ref: parts[0]!.ref,
			assessment: "fixture",
		});
	const single = await f.service.selectSkill(prior, {
		signal: signal(),
		reserve: async () => {},
	});
	const priorBound = f.write(() =>
		f.service.bindSkillSelection(f.db, prior, single, f.auth),
	);
	f.ports.inference.complete = old;
	const lean = { ...f.ports, assemblyMode: "lean" as const };
	const a = parts[0]!.artifact;
	const compatible = {
		instructions: parts[0]!.template.generator!.instructions,
		rendererVersion: a.rendererVersion,
		sourceExtractorVersion: a.sourceExtractorVersion,
	};
	const unconfigured = createSkillSmith(lean);
	expect(
		unconfigured.prepareSkillSelection(f.db, request, f.auth).candidates,
	).toHaveLength(0);
	expect(
		(
			await unconfigured.getSkillDelivery(
				priorBound.requestRef!,
				f.auth,
				f.read,
				signal(),
			)
		).kind,
	).toBe("rejected");
	const wrong = createSkillSmith({
		...lean,
		approvedDeliveryCompatibility: [
			{ ...compatible, rendererVersion: "other" },
		],
	});
	expect(
		wrong.prepareSkillSelection(f.db, request, f.auth).candidates,
	).toHaveLength(0);
	const service = createSkillSmith({
		...lean,
		approvedDeliveryCompatibility: [compatible],
	});
	const existing = await service.getSkillDelivery(
		priorBound.requestRef!,
		f.auth,
		f.read,
		signal(),
	);
	expect(existing.kind).toBe("ready");
	const prepared = service.prepareSkillSelection(
		f.db,
		{ ...request, requestId: "compose" },
		f.auth,
	);
	let reservations = 0;
	const selected = await service.selectSkill(prepared, {
		signal: signal(),
		reserve: async () => {
			reservations++;
		},
	});
	const bound = f.write(() =>
		service.bindSkillSelection(f.db, prepared, selected, f.auth),
	);
	const result = await service.getSkillDelivery(
		bound.requestRef!,
		f.auth,
		f.read,
		signal(),
	);
	if (result.kind !== "ready") throw new Error(JSON.stringify(result));
	expect(skillDeliverySchema.safeParse(result).success).toBe(true);
	expect(reservations).toBe(2);
	expect(result.skill.content).toContain("approved records for observe");
	expect(result.skill.content).toContain("approved records for compare");
	expect(result.skill.files?.map((file) => file.content)).toEqual([
		"observe fixture",
		"compare fixture",
	]);
	const audit = await service.getSkillAudit(
		result.auditRef,
		f.auth,
		f.read,
		signal(),
	);
	if (audit.kind !== "ready") throw new Error("audit_required");
	expect(
		audit.build.publication?.composition?.parts.map((part) => part.ref),
	).toEqual(parts.map((part) => part.ref));
	expect(audit.build.usage).toMatchObject({
		modelCalls: 2,
		inputTokens: 22,
		outputTokens: 14,
	});
	setCompositionAllowed(false);
	expect(
		(
			await service.getSkillDelivery(
				bound.requestRef!,
				f.auth,
				f.read,
				signal(),
			)
		).kind,
	).toBe("rejected");
	setCompositionAllowed(true);
	approvals.delete(parts[1]!.digest);
	expect(
		(
			await service.getSkillDelivery(
				bound.requestRef!,
				f.auth,
				f.read,
				signal(),
			)
		).kind,
	).toBe("rejected");
});

test("a positive semantic review alone cannot bind a combination without owner approval", async () => {
	const { f, request, setCompositionAllowed } = await approvedPair();
	const prepared = f.service.prepareSkillSelection(f.db, request, f.auth);
	const choice = await f.service.selectSkill(prepared, {
		signal: signal(),
		reserve: async () => {},
	});
	expect(choice.decision.kind).toBe("composed");
	setCompositionAllowed(false);
	expect(() =>
		f.write(() => f.service.bindSkillSelection(f.db, prepared, choice, f.auth)),
	).toThrow("composition_not_approved");
	expect(
		f.db.query("SELECT COUNT(*) AS count FROM knowledge_requests").get(),
	).toEqual({ count: 2 });
});

test("composition rejects reference collisions before writing a binding", async () => {
	const { f, request } = await approvedPair(true);
	const prepared = f.service.prepareSkillSelection(f.db, request, f.auth);
	const choice = await f.service.selectSkill(prepared, {
		signal: signal(),
		reserve: async () => {},
	});
	expect(choice.decision).toEqual({
		kind: "miss",
		reason: "composition_incompatible",
	});
	expect(choice.usage.modelCalls).toBe(1);
	expect(() =>
		f.write(() => f.service.bindSkillSelection(f.db, prepared, choice, f.auth)),
	).toThrow("selection_unavailable");
	expect(
		f.db.query("SELECT COUNT(*) AS count FROM knowledge_requests").get(),
	).toEqual({ count: 2 });
});

test("a positive selector cannot bind a bundle rejected by the independent review", async () => {
	const { f, request } = await approvedPair();
	const selector = f.ports.inference;
	f.ports.compositionReviewInference = {
		...selector,
		complete: async ({ data }) => {
			expect(data).toMatchObject({
				passages: expect.arrayContaining([
					expect.objectContaining({ text: "observe fixture" }),
					expect.objectContaining({ text: "compare fixture" }),
				]),
			});
			return answer({
				approved: false,
				reason: "The required dependency is absent.",
			});
		},
	};
	const prepared = f.service.prepareSkillSelection(f.db, request, f.auth);
	const choice = await f.service.selectSkill(prepared, {
		signal: signal(),
		reserve: async () => {},
	});
	expect(choice.decision).toEqual({
		kind: "miss",
		reason: "The required dependency is absent.",
	});
	expect(choice.usage.modelCalls).toBe(2);
	expect(() =>
		f.write(() => f.service.bindSkillSelection(f.db, prepared, choice, f.auth)),
	).toThrow("selection_unavailable");
	expect(
		f.write(() =>
			f.service.submitAfterSkillMiss(f.db, prepared, choice, f.auth),
		).kind,
	).toBe("pending");
});

test("composition review cannot certify a requirement with only the bundle heading", async () => {
	const { f, request } = await approvedPair();
	f.ports.compositionReviewInference = {
		...f.ports.inference,
		complete: async () =>
			answer({ approved: true, checks: [{ id: "acceptance:1", passage: 1 }] }),
	};
	const prepared = f.service.prepareSkillSelection(f.db, request, f.auth);
	const choice = await f.service.selectSkill(prepared, {
		signal: signal(),
		reserve: async () => {},
	});
	expect(choice.decision).toEqual({
		kind: "miss",
		reason: "composition_evidence_incomplete",
	});
});
