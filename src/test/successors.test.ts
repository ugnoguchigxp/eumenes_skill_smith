import { expect, test } from "bun:test";
import type { Evidence } from "../index.js";
import { fixture } from "./fixture.js";

const doc = (ref: string, extra: Partial<Evidence> = {}): Evidence => ({
	ref,
	version: { id: ref, version: "1", digest: "d-" + ref, generation: 0 },
	title: ref,
	status: "active",
	complete: true,
	external: false,
	scope: "shared",
	body: "b",
	...extra,
});
function setup(
	store: Record<string, Evidence>,
	cards: string[],
	documents = 4,
) {
	const f = fixture();
	const inputs: {
		search: Record<string, unknown>;
		untrustedEvidence: Evidence[];
	}[] = [];
	f.ports.registry.search = async () =>
		cards.map((ref) => {
			const { body: _b, sections: _s, ...card } = store[ref]!;
			return card;
		});
	f.ports.registry.read = async (ref) => {
		if (!store[ref]) throw new Error("not_found");
		return structuredClone(store[ref]!);
	};
	const complete = f.ports.inference.complete;
	f.ports.inference.complete = async (input, signal) => {
		inputs.push(structuredClone(input.data) as never);
		return complete(input, signal);
	};
	const r = f.submit({
		...f.request,
		limits: { ...f.request.limits, documents, candidates: 4 },
	});
	return { f, inputs, run: () => f.run(r.requestRef!).catch(() => undefined) };
}
test("a superseded document's published successor is fetched within the document budget", async () => {
	const s = setup(
		{
			old: doc("old", { status: "superseded", supersededBy: "new" }),
			new: doc("new"),
		},
		["old"],
	);
	await s.run();
	expect(s.inputs[0]!.untrustedEvidence.map((e) => e.ref)).toEqual([
		"old",
		"new",
	]);
	expect(s.inputs[0]!.search.successors).toEqual([
		{ ref: "old", successor: "new", outcome: "fetched" },
	]);
});
test("missing, cyclic and over-budget successors are reported as insufficiency, not followed", async () => {
	const missing = setup(
		{
			a: doc("a", { status: "superseded", supersededBy: "gone" }),
			// Returned but unusable (wrong ref) counts as unavailable, not transport error.
			gone: doc("other-ref"),
		},
		["a"],
	);
	await missing.run();
	expect(missing.inputs[0]!.search.successors).toEqual([
		{ ref: "a", successor: "gone", outcome: "unavailable" },
	]);
	expect(missing.inputs[0]!.untrustedEvidence.map((e) => e.ref)).toEqual(["a"]);
	const cycle = setup(
		{
			a: doc("a", { status: "superseded", supersededBy: "b" }),
			b: doc("b", { status: "superseded", supersededBy: "a" }),
		},
		["a"],
	);
	await cycle.run();
	expect(cycle.inputs[0]!.search.successors).toEqual([
		{ ref: "a", successor: "b", outcome: "fetched" },
		{ ref: "b", successor: "a", outcome: "cycle" },
	]);
	const limit = setup(
		{
			a: doc("a", { status: "superseded", supersededBy: "n" }),
			n: doc("n"),
		},
		["a"],
		1,
	);
	await limit.run();
	expect(limit.inputs[0]!.search.successors).toEqual([
		{ ref: "a", successor: "n", outcome: "limit" },
	]);
	expect(limit.inputs[0]!.untrustedEvidence.map((e) => e.ref)).toEqual(["a"]);
});
test("successor reads spend the shared source budget and cannot exceed it", async () => {
	const f = fixture();
	f.ports.registry.search = async () => [
		{
			ref: "a",
			version: { id: "a", version: "1", digest: "d", generation: 0 },
			title: "a",
			status: "superseded",
			complete: true,
			external: false,
			scope: "shared",
			supersededBy: "n",
		},
	];
	f.ports.registry.read = async (ref) =>
		ref === "a"
			? doc("a", {
					status: "superseded",
					supersededBy: "n",
					version: { id: "a", version: "1", digest: "d", generation: 0 },
				})
			: doc("n");
	const r = f.submit({
		...f.request,
		limits: { ...f.request.limits, sourceCalls: 2 },
	});
	await expect(f.run(r.requestRef!)).rejects.toThrow("budget_exceeded");
	expect(f.modelCalls()).toBe(0);
});
test("a successor outside the requester's scope is not adopted", async () => {
	const s = setup(
		{
			a: doc("a", { status: "superseded", supersededBy: "x" }),
			x: doc("x", { scope: "someone-else" }),
		},
		["a"],
	);
	await s.run();
	expect(s.inputs[0]!.search.successors).toEqual([
		{ ref: "a", successor: "x", outcome: "unavailable" },
	]);
	expect(s.inputs[0]!.untrustedEvidence.map((e) => e.ref)).toEqual(["a"]);
});

test("a transport failure while fetching a successor is reported as error", async () => {
	const f = fixture();
	const inputs: { search: Record<string, unknown> }[] = [];
	f.ports.registry.search = async () => [
		{
			ref: "a",
			version: { id: "a", version: "1", digest: "d", generation: 0 },
			title: "a",
			status: "superseded",
			complete: true,
			external: false,
			scope: "shared",
			supersededBy: "n",
		},
	];
	f.ports.registry.read = async (ref) => {
		if (ref === "a")
			return doc("a", {
				status: "superseded",
				supersededBy: "n",
				version: { id: "a", version: "1", digest: "d", generation: 0 },
			});
		throw new Error("network_down");
	};
	const complete = f.ports.inference.complete;
	f.ports.inference.complete = async (input, signal) => {
		inputs.push(structuredClone(input.data) as never);
		return complete(input, signal);
	};
	const r = f.submit({
		...f.request,
		limits: { ...f.request.limits, documents: 4 },
	});
	await f.run(r.requestRef!).catch(() => undefined);
	expect(inputs[0]!.search.successors).toEqual([
		{ ref: "a", successor: "n", outcome: "error" },
	]);
});
