import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchArgs } from "../contracts.js";
import { parseSearchProfile } from "../scenario-runner.js";
import { handle, item, setup } from "./fixture.js";

test("profile parsing is strict and defaults to handle", () => {
	expect(parseSearchProfile([])).toBe("handle");
	expect(parseSearchProfile(["--search-profile", "handle"])).toBe("handle");
	expect(parseSearchProfile(["--search-profile", "bm25"])).toBe("bm25");
	for (const args of [["--search-profile"], ["--search-profile", "semantic"]])
		expect(() => parseSearchProfile(args)).toThrow("unknown --search-profile");
	expect(setup().fixture.searchProfile).toBe("handle");
});

test("BM25 changes only order: score, handle ties, then short-only hits", () => {
	const docs = [
		item({ handle: handle("a"), title: "xy short only" }),
		item({
			handle: handle("b"),
			title: "needle with some additional filler text",
		}),
		item({ handle: handle("c"), title: "needle" }),
		item({ handle: handle("d"), title: "needle" }),
		item({ handle: handle("e"), title: "unmatched" }),
	];
	const baseline = setup(docs);
	const ranked = setup(docs, "bm25");
	const query = (q: string) => searchArgs.parse({ query: q, limit: 20 });
	const handles = (f: typeof baseline, q: string) =>
		f.fixture.search(query(q)).results.map((r) => r.handle);
	expect(handles(baseline, "needle xy")).toEqual(
		["a", "b", "c", "d"].map((x) => handle(x)),
	);
	expect(handles(ranked, "needle xy")).toEqual(
		["c", "d", "b", "a"].map((x) => handle(x)),
	);
	expect(handles(ranked, "xy")).toEqual(handles(baseline, "xy"));
	expect(handles(ranked, "x")).toEqual([]);
	// No profile may bypass visibility / retrieval / requested filters.
	for (const f of [baseline, ranked]) {
		f.put(item({ handle: handle("f"), title: "needle" }), {
			retrieval: "hidden",
		});
		f.put(item({ handle: handle("g"), title: "needle", status: "superseded" }));
		expect(handles(f, "needle xy").sort()).toEqual(
			["a", "b", "c", "d"].map((x) => handle(x)),
		);
	}
});

test("CLI reports the selected profile, including the omitted-flag baseline", () => {
	const f = setup();
	const suite = join(f.dir, "suite.json");
	// Use the validated legacy schema for the CLI integration test.
	const legacy = JSON.parse(
		readFileSync("examples/contextstill/scenarios/suite.json", "utf8"),
	);
	legacy.id = "profiles";
	legacy.tasks = [legacy.tasks[0]];
	writeFileSync(suite, JSON.stringify(legacy));
	for (const profile of [undefined, "handle", "bm25"] as const) {
		const result = Bun.spawnSync([
			process.execPath,
			"examples/contextstill/scenario-eval.ts",
			"--retrieval-only",
			"--db",
			f.path,
			"--suite",
			suite,
			"--output-dir",
			f.dir,
			...(profile ? ["--search-profile", profile] : []),
		]);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout.toString());
		expect(report.searchProfile).toBe(profile ?? "handle");
		expect(report.inferenceCalls).toBe(0);
		expect(
			JSON.parse(readFileSync(report.reportFile, "utf8")).searchProfile,
		).toBe(profile ?? "handle");
	}
});
