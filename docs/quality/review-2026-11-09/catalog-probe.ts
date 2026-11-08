import { writeFileSync } from "node:fs";
const root = process.argv[2]!;
await import(root + "/scripts/test-preload.ts");
const { fixture, ready } = await import(root + "/src/test/fixture-host.ts");
const { sqliteApprovedSkills } = await import(root + "/src/sqlite/index.ts");
const f = fixture();
try {
	f.ports.approvedSkills = sqliteApprovedSkills({
		authorizePublication: () => true,
		approvalCurrent: () => true,
	});
	const first = await ready(f);
	const wanted = f.write(() =>
		f.service.publishSkill(
			f.db,
			{
				buildRef: first.build.ref,
				applicability: "Compare sources without mutation.",
				approvalRef: "approval:first",
			},
			f.auth,
		),
	);
	const only = f.service.prepareSkillSelection(
		f.db,
		{ ...f.request, requestId: "probe:initial" },
		f.auth,
	);
	for (let i = 0; i < 8; i++) {
		const request = {
			...structuredClone(f.request),
			requestId: "different-environment:" + i,
			environment: {
				...structuredClone(f.request.environment),
				id: "environment:" + i,
			},
		};
		const pending = f.submit(request);
		const work = await f.run(pending.requestRef!);
		if (!work.settle()) throw Error("settlement_failed");
		const reply = f.service.get(f.db, pending.requestRef!, f.auth);
		if (reply.kind !== "ready") throw Error("ready_required");
		f.write(() =>
			f.service.publishSkill(
				f.db,
				{
					buildRef: reply.build.ref,
					applicability: "Only the original environment.",
					approvalRef: "approval:" + i,
				},
				f.auth,
			),
		);
	}
	const limited = f.service.prepareSkillSelection(
		f.db,
		{ ...f.request, requestId: "probe:limited" },
		f.auth,
	);
	const wider = f.service.prepareSkillSelection(
		f.db,
		{
			...f.request,
			requestId: "probe:wide",
			limits: { ...f.request.limits, candidates: 20 },
		},
		f.auth,
	);
	const chosen = await f.service.selectSkill(limited, {
		signal: new AbortController().signal,
		reserve: async () => {
			throw Error("should_not_call_model");
		},
	});
	const outcome = {
		snapshot: "fc555b4d0f708e57380924b053f84f0140d1efc2",
		networkCalls: 0,
		paidModelCalls: 0,
		fixtureGenerationCalls: f.modelCalls(),
		totalActivePublications: 9,
		baselineCompatibleCandidates: only.candidates.length,
		defaultCandidateLimit: f.request.limits.candidates,
		defaultCompatibleCandidates: limited.candidates.length,
		defaultDecision: chosen.decision,
		widerCandidateLimit: 20,
		widerCompatibleCandidates: wider.candidates.length,
		originalStillAvailable:
			f.ports.approvedSkills.get(f.db, wanted.ref) !== null,
		widerRecoversOriginal: wider.candidates.some((r) => r.ref === wanted.ref),
		condition:
			"One eligible publication followed by eight active approved publications for different exact environment IDs in the same scope. SQL LIMIT precedes compatibility filtering.",
		scope:
			"Deterministic SQLite/default-store candidate recall. Inference is a fixture, never an applicability-quality benchmark.",
	};
	if (
		outcome.baselineCompatibleCandidates !== 1 ||
		outcome.defaultCompatibleCandidates !== 0 ||
		outcome.widerCompatibleCandidates !== 1 ||
		!outcome.widerRecoversOriginal
	)
		throw Error("probe_inconclusive");
	writeFileSync(
		"/tmp/smith-review-catalog-probe.json",
		JSON.stringify(outcome, null, 2) + "\n",
	);
	console.log(JSON.stringify(outcome));
} finally {
	f.dispose();
}
