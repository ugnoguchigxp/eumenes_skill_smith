import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";

test("induceAndSaveWorkflow stores a proposed candidate only", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	f.setOutput({
		sections: [{ id: "common", body: "共通確認をする。" }],
		conditions: ["成功が複数"],
		evidence: [],
	});
	const proposal = await f.write(async () =>
		f.service.induceAndSaveWorkflow(
			f.db,
			{
				buildRef: r.build.ref,
				executionRef: "execution:1",
				taskGoal: f.request.task.goal,
				succeededSummaries: ["できた", "またできた"],
				evidence: [],
			},
			f.auth,
			{
				signal: new AbortController().signal,
				reserve: async () => {},
			},
		),
	);
	expect(proposal.status).toBe("proposed");
	expect(proposal.executionVerified).toBeUndefined();
	expect(proposal.sections[0]!.id).toBe("common");
});
