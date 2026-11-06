import { writeSkillArtifact } from "./skill-output.js";
// Exports the exact build inference task for a live provider (Grok Bot) and replays its record.
// Usage: bun run context:task [db] [query] [records.json] [output-dir]
// Writes data/contextstill/inference-task.json (git-ignored; may contain copied knowledge bodies).
import "../../scripts/test-preload.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContextStillFixture } from "./database.js";
import { createMcpHandler } from "./mcp.js";
import { createFixtureSource } from "./source.js";
import { createExampleHost } from "./host.js";
import {
	recordedInference,
	type InferenceRecord,
	type InferenceTask,
} from "./recorded.js";

const path = resolve(process.argv[2] ?? "data/contextstill/seed.sqlite");
const query = process.argv[3] ?? "検証";
const records: InferenceRecord[] = process.argv[4]
	? JSON.parse(readFileSync(resolve(process.argv[4]), "utf8"))
	: [];
const fixture = new ContextStillFixture(path);
const token = crypto.randomUUID();
const source = createFixtureSource(createMcpHandler(fixture, token), token);
const tasks: InferenceTask[] = [];
const host = createExampleHost(
	source,
	query,
	recordedInference(records, (t) => tasks.push(t)),
);
try {
	const reply = await host.run().catch((e: Error) => ({ kind: e.message }));
	const skillFile =
		reply.kind === "ready" && "skill" in reply
			? writeSkillArtifact(
					resolve(process.argv[5] ?? "data/contextstill/task-output"),
					reply.skill,
				)
			: null;
	const out = resolve("data/contextstill/inference-task.json");
	mkdirSync(resolve("data/contextstill"), { recursive: true });
	if (tasks.length) writeFileSync(out, JSON.stringify(tasks.at(-1), null, 2));
	console.log(
		JSON.stringify({
			status: reply.kind,
			skillFile,
			...(reply.kind === "needs_input" && "missing" in reply
				? { missing: reply.missing }
				: {}),
			taskFile: tasks.length ? out : null,
			inputDigest: tasks.at(-1)?.inputDigest ?? null,
			records: records.length,
			model: records.length ? "recorded_provider_output" : "awaiting_provider",
			network: false,
		}),
	);
} finally {
	host.close();
	fixture.close();
}
