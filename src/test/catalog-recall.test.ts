import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
import { sqliteApprovedSkills } from "../sqlite/index.js";
import { publicationDigest } from "../service/approved-skills.js";
import { createSkillSmith, digest, type ApprovedSkill } from "../index.js";

async function catalog() {
	const f = fixture();
	const built = await ready(f);
	f.ports.approvedSkills = sqliteApprovedSkills({
		authorizePublication: () => true,
		approvalCurrent: () => true,
	});
	const pub = f.write(() =>
		f.service.publishSkill(
			f.db,
			{
				buildRef: built.build.ref,
				applicability: "Compare original sources without mutation.",
				approvalRef: "approval:original",
			},
			f.auth,
		),
	);
	const original = f.ports.approvedSkills.get(f.db, pub.ref)!;
	function add(i: number, change: (r: ApprovedSkill) => void) {
		const r = structuredClone(original);
		r.ref = "publication:filler:" + i;
		r.approvalRef = "approval:filler:" + i;
		change(r);
		r.template.digest = digest(r.template.content);
		r.digest = publicationDigest(r);
		f.ports.approvedSkills!.put(f.db, r);
		return r;
	}
	return { ...f, original, add };
}
for (const count of [8, 25, 1000])
	test(`eligible older skill remains visible behind ${count} incompatible registrations`, async () => {
		const f = await catalog();
		f.write(() => {
			for (let i = 0; i < count; i++)
				f.add(i, (r) => {
					r.template.content.environment.id = "different:" + i;
				});
		});
		const result = f.service.prepareSkillSelection(
			f.db,
			{ ...f.request, requestId: "recall:" + count },
			f.auth,
		);
		expect(result.candidates.map((c) => c.ref)).toEqual([f.original.ref]);
	});

test("ineligible policies, audiences, capabilities and expired rows do not occupy the candidate budget", async () => {
	const f = await catalog();
	f.write(() => {
		for (let i = 0; i < 40; i++)
			f.add(i, (r) => {
				switch (i % 4) {
					case 0:
						r.template.content.environment.policy.version = "other";
						break;
					case 1:
						r.template.content.audience = "external";
						break;
					case 2:
						r.template.content.environment.capabilities[0]!.version = "other";
						break;
					case 3:
						r.expiresAt = f.ports.now() - 1;
						break;
				}
			});
	});
	const result = f.service.prepareSkillSelection(f.db, f.request, f.auth);
	expect(result.candidates.map((c) => c.ref)).toEqual([f.original.ref]);
});

test("revoked approvals and roots are refilled before limiting useful candidates", async () => {
	const f = await catalog();
	f.ports.approvedSkills!.approvalCurrent = (_tx, r) =>
		r.approvalRef === "approval:original";
	f.write(() => {
		for (let i = 0; i < 50; i++) f.add(i, () => {});
	});
	expect(
		f.service
			.prepareSkillSelection(f.db, f.request, f.auth)
			.candidates.map((c) => c.ref),
	).toEqual([f.original.ref]);
});

test("an exhausted structural scan never turns an unseen candidate into an absence claim", async () => {
	const f = await catalog();
	f.ports.approvedSkills!.approvalCurrent = (_tx, r) =>
		r.approvalRef === "approval:original";
	f.write(() => {
		for (let i = 0; i < 50; i++) f.add(i, () => {});
	});
	f.ports.limits = { approvedScanLimit: 16 };
	const service = createSkillSmith(f.ports);
	expect(() => service.prepareSkillSelection(f.db, f.request, f.auth)).toThrow(
		"catalog_scan_limit",
	);
});

test("metadata ranking can find an older topic inside a large compatible environment", async () => {
	const f = await catalog();
	const relevant = f.add(10001, (r) => {
		r.template.content.task.goal =
			"Trace OpenTelemetry context propagation across asynchronous workers";
		r.applicability =
			"Diagnose distributed trace propagation and missing parent spans";
	});
	f.write(() => {
		for (let i = 0; i < 1000; i++)
			f.add(i, (r) => {
				r.template.content.task.goal =
					"Maintain CSS typography and image layout";
				r.applicability = "Responsive text and image presentation";
			});
	});
	const prepared = f.service.prepareSkillSelection(
		f.db,
		{
			...f.request,
			task: {
				...f.request.task,
				goal: "Investigate OpenTelemetry propagation in worker traces",
			},
		},
		f.auth,
	);
	expect(prepared.candidates.map((c) => c.ref)).toContain(relevant.ref);
	expect(prepared.candidates.length).toBeLessThanOrEqual(
		f.request.limits.candidates,
	);
});

test("empty lexical matches retain structurally compatible paraphrase candidates", async () => {
	const f = await catalog();
	const prepared = f.service.prepareSkillSelection(
		f.db,
		{
			...f.request,
			task: {
				...f.request.task,
				goal: "別表現による照合レポートを提案してください",
			},
		},
		f.auth,
	);
	expect(prepared.candidates.map((c) => c.ref)).toEqual([f.original.ref]);
});

test("a revoked lexical hit cannot hide the structural fallback", async () => {
	const f = await catalog();
	f.ports.approvedSkills!.approvalCurrent = (_tx, r) =>
		r.ref === f.original.ref;
	f.add(100, (r) => {
		r.template.content.task.goal = "Configure keyboard firmware";
		r.applicability = "Configure a keyboard";
	});
	const result = f.service.prepareSkillSelection(
		f.db,
		{
			...f.request,
			task: { ...f.request.task, goal: "keyboard" },
		},
		f.auth,
	);
	expect(result.candidates.map((r) => r.ref)).toEqual([f.original.ref]);
	expect(result.catalog.exhausted).toBe(true);
});

test("a full ranked range leaves space for compatible nonmatching candidates", async () => {
	const f = await catalog();
	f.request.limits.candidates = 3;
	for (let i = 0; i < 12; i++)
		f.add(i, (r) => {
			r.template.content.task.goal = "Configure keyboard firmware";
			r.applicability = "Configure a keyboard";
		});
	// A recent nonmatching publication must have a chance even in a dense topic.
	const other = f.add(100, () => {});
	const result = f.service.prepareSkillSelection(
		f.db,
		{
			...f.request,
			task: { ...f.request.task, goal: "keyboard" },
		},
		f.auth,
	);
	expect(result.candidates).toHaveLength(3);
	expect(result.candidates.map((r) => r.ref)).toContain(other.ref);
});

test("catalog query punctuation cannot change SQL or expand scope", async () => {
	const f = await catalog();
	f.write(() => {
		for (let i = 0; i < 20; i++)
			f.add(i, (r) => {
				r.scope = "foreign";
			});
	});
	const prepared = f.service.prepareSkillSelection(
		f.db,
		{
			...f.request,
			task: {
				...f.request.task,
				goal: '" OR * NEAR("foreign") -- ; DROP TABLE knowledge_approved_skills;',
			},
		},
		f.auth,
	);
	expect(prepared.candidates.every((r) => r.scope === f.auth.scope)).toBe(true);
	expect(
		f.db.query("SELECT count(*) AS n FROM knowledge_approved_skills").get(),
	).toEqual({ n: 21 });
});

test("search projection follows deletion and indexed structural filters stay in the query plan", async () => {
	const f = await catalog();
	const queries: string[] = [];
	const original = f.db.query.bind(f.db);
	f.db.query = ((sql: string) => {
		queries.push(sql);
		return original(sql);
	}) as typeof f.db.query;
	f.service.prepareSkillSelection(f.db, f.request, f.auth);
	f.db.query = original;
	const sql = queries.find((q) =>
		q.includes("SELECT knowledge_approved_skills.rowid"),
	)!;
	const env = f.request.environment;
	const plan = f.db
		.query("EXPLAIN QUERY PLAN " + sql)
		.all(
			f.auth.scope,
			env.id,
			f.request.audience,
			env.policy.id,
			env.policy.version,
			env.policy.digest,
			env.policy.generation,
			f.ports.now(),
			Number.MAX_SAFE_INTEGER,
			JSON.stringify(env.capabilities),
			33,
			0,
		);
	expect(JSON.stringify(plan)).toContain("knowledge_approved_compat");
	f.service.forget(f.db, [f.original.ref]);
	expect(
		f.db.query("SELECT rowid FROM knowledge_approved_search").all(),
	).toHaveLength(0);
});

test("a full small catalog is reported exhausted even when it fills the candidate limit", async () => {
	const f = await catalog();
	const prepared = f.service.prepareSkillSelection(
		f.db,
		{ ...f.request, limits: { ...f.request.limits, candidates: 1 } },
		f.auth,
	);
	expect(prepared.catalog).toEqual({ scanned: 1, exhausted: true });
});

test("expired selection never reserves another paid call", async () => {
	const f = await catalog(),
		prepared = f.service.prepareSkillSelection(f.db, f.request, f.auth);
	f.advance(120001);
	let calls = 0;
	await expect(
		f.service.selectSkill(prepared, {
			signal: new AbortController().signal,
			reserve: async () => {
				calls++;
			},
		}),
	).rejects.toThrow("deadline_exceeded");
	expect(calls).toBe(0);
});
