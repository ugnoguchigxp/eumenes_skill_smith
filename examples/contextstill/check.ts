// Keep the seed/real-copy smoke just as isolated as the fixed tests.
import "../../scripts/test-preload.js";
import { resolve } from "node:path";
import { ContextStillFixture } from "./database.js";
import { createMcpHandler } from "./mcp.js";
import { createFixtureSource } from "./source.js";
import { createExampleHost } from "./host.js";

const path = resolve(process.argv[2] ?? "data/contextstill/seed.sqlite");
const query = process.argv[3] ?? "検証";
const fixture = new ContextStillFixture(path);
const token = crypto.randomUUID(); // Process-local only; neither saved nor printed.
const source = createFixtureSource(createMcpHandler(fixture, token), token);
const host = createExampleHost(source, query);
try {
	const cards = await source.search(query, 8, new AbortController().signal);
	if (!cards.length) throw new Error("snapshot_search_empty_try_another_query");
	const reply = await host.run();
	if (reply.kind !== "ready") throw new Error(`snapshot_wiring_${reply.kind}`);
	console.log(
		JSON.stringify({
			status: "ok",
			counts: fixture.counts(),
			searchResults: cards.length,
			build: reply.kind,
			dependencies: reply.build.content.dependencies.length,
			usage: reply.build.usage,
			model: "fixed_wiring_stub",
			search: "lexical_only",
			network: false,
			listener: false,
		}),
	);
} finally {
	host.close();
	fixture.close();
}
