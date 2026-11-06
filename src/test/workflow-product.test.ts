import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
import { sqliteRepository } from "../sqlite/index.js";

test("prepare/induce/save workflow stores a proposed candidate only", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	f.setOutput({
		sections: [{ id: "common", body: "共通確認をする。" }],
		conditions: ["成功が複数"],
		evidence: [],
	});
	const prepared = f.write(() =>
		f.service.prepareWorkflow(
			f.db,
			{
				buildRef: r.build.ref,
				executionRef: "execution:1",
				taskGoal: f.request.task.goal,
				succeededSummaries: ["できた", "またできた"],
				evidence: [],
			},
			f.auth,
		),
	);
	const induced = await f.service.induceWorkflow(prepared, {
		signal: new AbortController().signal,
		reserve: async () => {},
	});
	const proposal = f.write(() =>
		f.service.saveWorkflow(f.db, prepared, induced, f.auth),
	);
	expect(proposal.status).toBe("proposed");
	expect(proposal.executionVerified).toBeUndefined();
	expect(proposal.sections[0]!.id).toBe("common");
});

test("workflow save refuses after authority becomes invalid during inference", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "exec", f.auth, f.request);
	const prepared = f.write(() =>
		f.service.prepareWorkflow(
			f.db,
			{
				buildRef: r.build.ref,
				executionRef: "exec",
				taskGoal: "x",
				succeededSummaries: ["unverified caller summary"],
				evidence: [],
			},
			f.auth,
		),
	);
	f.ports.inference.complete = async () => {
		f.setValid(false);
		return {
			value: {
				sections: [{ id: "s", body: "step" }],
				conditions: ["c"],
				evidence: [],
			},
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		};
	};
	const induced = await f.service.induceWorkflow(prepared, {
		signal: new AbortController().signal,
		reserve: async () => {},
	});
	expect(() =>
		f.write(() => f.service.saveWorkflow(f.db, prepared, induced, f.auth)),
	).toThrow("stale_result");
	expect(sqliteRepository.proposal(f.db, "missing")).toBeNull();
	// No proposal should have been saved for this execution.
	const rows = f.db
		.query("SELECT data_json FROM knowledge_proposals")
		.all() as { data_json: string }[];
	expect(
		rows.every((row) => !row.data_json.includes('"executionRef":"exec"')),
	).toBe(true);
});

test("workflow save refuses when the bound report is corrected mid-flight", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	const report = {
		reportId: "r1",
		buildRef: r.build.ref,
		executionRef: "execution:1",
		outcome: "succeeded" as const,
		evidence: [],
		summary: "success",
		expectedRevision: 0,
	};
	f.service.reportResult(f.db, report, f.auth);
	const prepared = f.write(() =>
		f.service.prepareWorkflow(
			f.db,
			{
				buildRef: r.build.ref,
				executionRef: "execution:1",
				taskGoal: f.request.task.goal,
				succeededSummaries: ["success"],
				failedSummaries: ["earlier failure"],
				trajectories: [
					{
						action: "open",
						observation: "file present",
						outcome: "succeeded",
					},
				],
				evidence: [],
			},
			f.auth,
		),
	);
	expect(prepared.reportDigest).toBeTruthy();
	expect(prepared.failedSummaries).toEqual(["earlier failure"]);
	expect(prepared.trajectories).toHaveLength(1);
	f.setOutput({
		sections: [{ id: "s", body: "step" }],
		conditions: ["c"],
		evidence: [],
	});
	const induced = await f.service.induceWorkflow(prepared, {
		signal: new AbortController().signal,
		reserve: async () => {},
	});
	f.service.reportResult(
		f.db,
		{
			...report,
			reportId: "r2",
			outcome: "failed",
			summary: "correction",
			expectedRevision: 1,
		},
		f.auth,
	);
	expect(() =>
		f.write(() => f.service.saveWorkflow(f.db, prepared, induced, f.auth)),
	).toThrow("stale_result");
});
