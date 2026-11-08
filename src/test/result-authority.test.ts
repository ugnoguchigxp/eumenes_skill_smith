import { expect, test } from "bun:test";
import type { Authority } from "../index.js";
import { fixture, ready } from "./fixture.js";

const operations = [
	"report",
	"reflection",
	"workflow",
	"review",
	"mark",
	"bind",
	"reserve",
	"save",
	"fail",
] as const;
for (const mutation of [
	"principal",
	"scope",
	"epoch",
	"permission",
	"execution",
	"source",
] as const) {
	for (const operation of operations) {
		test(
			"result boundary rejects " +
				mutation +
				" in " +
				operation +
				" without mutation",
			async () => {
				const f = fixture();
				const r = await ready(f);
				const executionRef = "bound-execution";
				f.service.bindUse(f.db, r.build.ref, executionRef, f.auth, f.request);
				const report = {
					reportId: "owner-report",
					buildRef: r.build.ref,
					executionRef,
					outcome: "succeeded" as const,
					summary: "owner summary",
					evidence: [],
					improvement: "compare observations",
					expectedRevision: 0,
				};
				f.write(() => f.service.reportResult(f.db, report, f.auth));
				const reflection = f.write(() =>
					f.service.prepareReflection(f.db, executionRef, f.auth),
				)!;
				const workflowInput = {
					buildRef: r.build.ref,
					executionRef,
					taskGoal: f.request.task.goal,
					succeededSummaries: ["observed success"],
					evidence: [],
				};
				const workflow = f.service.prepareWorkflow(f.db, workflowInput, f.auth);
				const result = {
					content: {
						sections: [{ id: "check", body: "check originals" }],
						conditions: ["originals exist"],
						evidence: [],
					},
					receipt: "receipt",
					inputTokens: 1,
					outputTokens: 1,
				};
				const proposal = f.write(() =>
					f.service.saveWorkflow(f.db, workflow, result, f.auth),
				);
				if (operation === "save")
					f.write(() => f.service.reserveReflection(f.db, reflection, f.auth));
				const auth: Authority = structuredClone(f.auth);
				if (mutation === "principal") auth.principal = "other-principal";
				if (mutation === "scope") auth.scope = "other-scope";
				if (mutation === "epoch") auth.epoch++;
				if (mutation === "permission") auth.permissions = [];
				if (mutation === "execution" || mutation === "source") {
					const denied =
						mutation === "execution" ? executionRef : f.auth.sourceRefs[0]!;
					f.ports.authority.valid = (_tx, _auth, refs) =>
						!refs.includes(denied);
				}
				const snapshot = () =>
					JSON.stringify([
						f.db
							.query("SELECT * FROM knowledge_results ORDER BY execution_ref")
							.all(),
						f.db
							.query(
								"SELECT * FROM knowledge_report_receipts ORDER BY report_id",
							)
							.all(),
						f.db
							.query("SELECT * FROM knowledge_reflections ORDER BY ref")
							.all(),
						f.db.query("SELECT * FROM knowledge_proposals ORDER BY ref").all(),
						f.db.query("SELECT * FROM knowledge_requests ORDER BY ref").all(),
						f.db
							.query(
								"SELECT * FROM knowledge_dependencies ORDER BY owner,source",
							)
							.all(),
					]);
				const before = snapshot();
				const invoke = () =>
					f.write(() => {
						switch (operation) {
							case "report":
								return f.service.reportResult(
									f.db,
									{
										...report,
										reportId: "correction",
										expectedRevision: 1,
										outcome: "failed",
									},
									auth,
								);
							case "reflection":
								return f.service.prepareReflection(f.db, executionRef, auth);
							case "workflow":
								return f.service.prepareWorkflow(f.db, workflowInput, auth);
							case "review":
								return f.service.reviewProposal(
									f.db,
									proposal.ref,
									0,
									"validated",
									["proof"],
									auth,
								);
							case "mark":
								return f.service.markExecutionVerified(
									f.db,
									proposal.ref,
									0,
									auth,
								);
							case "bind":
								return f.service.bindCandidateVerification(
									f.db,
									proposal.ref,
									0,
									{
										proposalDigest: f.service.proposalContentDigest(proposal),
										outcome: "succeeded",
									},
									auth,
								);
							case "reserve":
								return f.service.reserveReflection(f.db, reflection, auth);
							case "save":
								return f.service.saveProposal(f.db, reflection, result, auth);
							case "fail":
								return f.service.failReflection(f.db, reflection, auth);
						}
					});
				expect(invoke).toThrow();
				expect(snapshot()).toBe(before);
			},
		);
	}
}
test("report-only owner retains result/reflection/workflow access and execution is checked", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution", f.auth, f.request);
	const auth: Authority = { ...f.auth, permissions: ["report"] };
	const refs: string[][] = [];
	f.ports.authority.valid = (_tx, _auth, values) => {
		refs.push(values);
		return true;
	};
	f.service.reportResult(
		f.db,
		{
			reportId: "report",
			buildRef: r.build.ref,
			executionRef: "execution",
			outcome: "succeeded",
			summary: "observed",
			improvement: "compare originals",
			evidence: [],
			expectedRevision: 0,
		},
		auth,
	);
	expect(
		f.service.prepareReflection(f.db, "execution", auth)?.grounding?.buildBody,
	).toBe(r.build.content.body);
	expect(
		f.service.prepareWorkflow(
			f.db,
			{
				buildRef: r.build.ref,
				executionRef: "execution",
				taskGoal: f.request.task.goal,
				succeededSummaries: ["observed"],
				evidence: [],
			},
			auth,
		).executionRef,
	).toBe("execution");
	expect(refs.some((items) => items.includes("execution"))).toBe(true);
});
