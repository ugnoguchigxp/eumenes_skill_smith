// Canonical measurement entrypoint: aggregates existing recorded SKILL scores and retrieval-only
// hit@k into one per-slice board. No LLM calls, no DB writes. Means are never blended across slices.
//   bun examples/contextstill/scoreboard.ts [--json] [--dir examples/contextstill/scenarios]
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Profile = "handle" | "bm25";
export const PROFILES: Profile[] = ["handle", "bm25"];
export const CANONICAL_CONDITIONS = {
	assemblyMode: "baseline",
	evidenceSupply: "natural",
	queryReformulation: "off",
	abstentionContrast: "off",
} as const;

export interface SliceDef {
	id: string;
	axis: "retrieval" | "compose" | "absent";
	queryStyle: string | null;
	label: string;
	scoreFiles: Record<Profile, string | null>;
	retrievalFiles: Record<Profile, string | null>;
}

export const SLICES: SliceDef[] = [
	{
		id: "retrieval/original",
		axis: "retrieval",
		queryStyle: "original",
		label: "当初5件（元の課題文）",
		scoreFiles: { handle: "scores.json", bm25: "scores-bm25.json" },
		retrievalFiles: {
			handle: "retrieval-original-handle.json",
			bm25: "retrieval-original-bm25.json",
		},
	},
	{
		id: "retrieval/exact",
		axis: "retrieval",
		queryStyle: "exact",
		label: "題名どおり16件",
		scoreFiles: { handle: null, bm25: null },
		retrievalFiles: {
			handle: "retrieval-exact-handle.json",
			bm25: "retrieval-exact-bm25.json",
		},
	},
	{
		id: "retrieval/en",
		axis: "retrieval",
		queryStyle: "en",
		label: "英語言い換え16件",
		scoreFiles: { handle: null, bm25: null },
		retrievalFiles: {
			handle: "retrieval-en-handle.json",
			bm25: "retrieval-en-bm25.json",
		},
	},
	{
		id: "retrieval/jp",
		axis: "retrieval",
		queryStyle: "jp",
		label: "日本語言い換え16件",
		scoreFiles: { handle: null, bm25: null },
		retrievalFiles: {
			handle: "retrieval-jp-handle.json",
			bm25: "retrieval-jp-bm25.json",
		},
	},
	{
		id: "compose",
		axis: "compose",
		queryStyle: null,
		label: "複合4件",
		scoreFiles: {
			handle: "scores-compose-natural-handle.json",
			bm25: "scores-compose-natural-bm25.json",
		},
		retrievalFiles: { handle: null, bm25: null },
	},
	{
		id: "absent",
		axis: "absent",
		queryStyle: null,
		label: "seedに該当なし4件",
		scoreFiles: { handle: "scores-absent-baseline.json", bm25: null },
		retrievalFiles: { handle: null, bm25: null },
	},
];

interface ScoreRow {
	taskId: string;
	score: number | null;
	kind: string | null;
	strategy: string | null;
	retrievalRank: number | null;
	expectedSkillUsed: boolean | null;
}

export interface Cell {
	profile: Profile;
	n: number;
	scored: number;
	unscored: number;
	meanScore: number | null;
	scores: ScoreRow[];
	scoreSource: string | null;
	scoreSourceSuite: string | null;
	hitAt8: { hit: number; of: number } | null;
	hitAt20Diagnostic: { hit: number; of: number } | null;
	retrievalSource: string | null;
	identity: unknown;
}

const read = (dir: string, f: string | null) => {
	if (!f) return null;
	const p = resolve(dir, f);
	return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

function conditionMismatch(r: any, profile: Profile): string | null {
	if (r.searchProfile !== profile) return `searchProfile ${r.searchProfile}`;
	const id = r.identity ?? {};
	for (const [k, v] of Object.entries(CANONICAL_CONDITIONS)) {
		const got = id[k] ?? r[k];
		if (got !== undefined && got !== v) return `${k} ${got}`;
	}
	return null;
}

export function buildScoreboard(dir = "examples/contextstill/scenarios") {
	const suite = JSON.parse(
		readFileSync(resolve(dir, "suite-3axis.json"), "utf8"),
	);
	const slices = SLICES.map((def) => {
		const taskIds: string[] = suite.tasks
			.filter(
				(t: any) =>
					t.axis === def.axis &&
					(def.queryStyle === null ||
						(t.queryStyle ?? "original") === def.queryStyle),
			)
			.map((t: any) => t.id);
		const cells = PROFILES.map((profile): Cell => {
			const sf = read(dir, def.scoreFiles[profile]);
			if (sf) {
				const bad = conditionMismatch(sf, profile);
				if (bad)
					throw new Error(`${def.scoreFiles[profile]}: non-canonical ${bad}`);
			}
			const byId = new Map<string, any>(
				(sf?.scores ?? []).map((s: any) => [s.taskId, s]),
			);
			const scores = taskIds.map((taskId): ScoreRow => {
				const s = byId.get(taskId);
				return {
					taskId,
					score: typeof s?.score === "number" ? s.score : null,
					kind: s?.kind ?? null,
					strategy: s?.strategy ?? null,
					retrievalRank: s?.retrievalRank ?? null,
					expectedSkillUsed: s ? (s.expectedSkillUsed ?? null) : null,
				};
			});
			const scored = scores.filter((s) => s.score !== null).length;
			const meanScore =
				scored === taskIds.length && scored > 0
					? Math.round(
							(scores.reduce((a, s) => a + (s.score as number), 0) / scored) *
								100,
						) / 100
					: null;
			const rf = read(dir, def.retrievalFiles[profile]);
			if (rf) {
				const bad = conditionMismatch(rf, profile);
				if (bad)
					throw new Error(
						`${def.retrievalFiles[profile]}: non-canonical ${bad}`,
					);
			}
			let hitAt8 = null,
				hitAt20Diagnostic = null;
			if (rf) {
				const rows = (rf.rows ?? []).filter((r: any) =>
					taskIds.includes(r.taskId),
				);
				if (rows.length !== taskIds.length)
					throw new Error(
						`${def.retrievalFiles[profile]}: ${rows.length}/${taskIds.length} rows`,
					);
				hitAt8 = {
					hit: rows.filter((r: any) => r.allRequiredHitAt8).length,
					of: rows.length,
				};
				hitAt20Diagnostic = {
					hit: rows.filter((r: any) => r.allRequiredHitAt20Diagnostic).length,
					of: rows.length,
				};
			}
			return {
				profile,
				n: taskIds.length,
				scored,
				unscored: taskIds.length - scored,
				meanScore,
				scores,
				scoreSource: sf ? def.scoreFiles[profile] : null,
				scoreSourceSuite: sf?.suite ?? null,
				hitAt8,
				hitAt20Diagnostic,
				retrievalSource: rf ? def.retrievalFiles[profile] : null,
				identity: {
					scores: sf?.identity ?? null,
					retrieval: rf?.identity ?? null,
				},
			};
		});
		return {
			id: def.id,
			axis: def.axis,
			queryStyle: def.queryStyle,
			label: def.label,
			n: taskIds.length,
			cells,
		};
	});
	return {
		suite: suite.id,
		totalTasks: slices.reduce((a, s) => a + s.n, 0),
		conditions: {
			handle: { searchProfile: "handle", ...CANONICAL_CONDITIONS },
			bm25: { searchProfile: "bm25", ...CANONICAL_CONDITIONS },
		},
		blendedMean: null,
		note: "SKILL score is a provisional 0-10 LLM judgment (not human-calibrated). Means are per slice x condition only; no blended mean across slices or axes. Provider tokens unmeasured.",
		slices,
	};
}

const frac = (h: { hit: number; of: number } | null) =>
	h ? `${h.hit}/${h.of}` : "未測定";

export function renderText(b: ReturnType<typeof buildScoreboard>): string {
	const L: string[] = [];
	L.push(
		`課題 ${b.totalTasks} 件（${b.slices.map((s) => `${s.id} ${s.n}`).join(" / ")}）`,
	);
	L.push(
		"SKILL点は LLM 判定の暫定値（0-10、人手較正なし）。平均は区分×条件ごとのみ。全体平均は出さない。",
	);
	L.push(
		"条件: handle / bm25（いずれも assembly baseline・evidence natural・言い換えoff・弃権対比off）",
	);
	L.push("");
	L.push(
		"区分                 n  | handle: SKILL採点  平均  hit@8 (hit@20) | bm25: SKILL採点  平均  hit@8 (hit@20)",
	);
	for (const s of b.slices) {
		const c = s.cells.map(
			(c) =>
				`${c.scored}/${c.n}${c.unscored ? `(未測定${c.unscored})` : ""}  ${c.meanScore ?? "-"}  ${s.axis === "retrieval" ? `${frac(c.hitAt8)} (${frac(c.hitAt20Diagnostic)})` : "hit@k対象外"}`,
		);
		L.push(`${s.id.padEnd(20)} ${String(s.n).padStart(2)} | ${c[0]} | ${c[1]}`);
	}
	L.push("");
	for (const s of b.slices) {
		for (const c of s.cells) {
			if (c.scored === 0) continue;
			L.push(
				`${s.id} ${c.profile}: 平均 ${c.meanScore ?? "null（未採点あり）"}  [${c.scores.map((x) => x.score ?? "未").join(", ")}]`,
			);
			for (const x of c.scores)
				L.push(
					`  ${x.taskId}: ${x.score ?? "未測定"}  ${x.kind ?? "-"}/${x.strategy ?? "-"}  rank ${x.retrievalRank ?? "-"}  expectedUsed ${x.expectedSkillUsed ?? "-"}`,
				);
		}
	}
	const missing = b.slices.flatMap((s) =>
		s.cells
			.filter((c) => c.unscored)
			.map((c) => `${s.id} ${c.profile} ${c.unscored}/${c.n}`),
	);
	L.push("");
	L.push(
		`SKILL未測定: ${missing.join(", ") || "なし"}。provider トークン: 未測定。`,
	);
	return L.join("\n");
}

if (import.meta.main) {
	const i = process.argv.indexOf("--dir");
	const board = buildScoreboard(i > 0 ? process.argv[i + 1] : undefined);
	console.log(
		process.argv.includes("--json")
			? JSON.stringify(board, null, 2)
			: renderText(board),
	);
}
