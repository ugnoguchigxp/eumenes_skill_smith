import { digest } from "../../src/service/identity.js";
import { z } from "zod";
import { buildEvalIdentity } from "./scenario-runner.js";
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
		scoreFiles: { handle: "scores-exact-handle.json", bm25: null },
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

/** Product default (bm25 + exact-title pin + reformulation auto). Separate from the
 * historical handle/bm25 (reformulation off) columns. SKILL files are per-slice; original
 * and compose remain unscored under this default. Diverse is a companion suite, not in 61. */
export const DEFAULT_RETRIEVAL_FILES: Record<string, string> = {
	"retrieval/original": "retrieval-original-default.json",
	"retrieval/exact": "retrieval-exact-default.json",
	"retrieval/en": "retrieval-en-default.json",
	"retrieval/jp": "retrieval-jp-default.json",
	compose: "retrieval-compose-default.json",
};

export const DEFAULT_SCORE_FILES: Record<string, string> = {
	"retrieval/exact": "scores-exact-default.json",
	"retrieval/en": "scores-en-default.json",
	"retrieval/jp": "scores-jp-default.json",
};

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

/** Validate a scored snapshot before Map construction (no silent duplicate overwrite). */
export function validateScoreRows(report: any, expectedIds: string[]) {
	const rows = z
		.array(
			z.object({
				taskId: z.string().min(1),
				score: z.number().int().min(0).max(10).nullable(),
			}),
		)
		.parse(report.scores);
	const ids = rows.map((x) => x.taskId);
	if (new Set(ids).size !== ids.length) throw new Error("score_duplicate_task");
	if (expectedIds.some((id) => !ids.includes(id)))
		throw new Error("score_missing_task");
}
export function currentIdentityMatches(
	actual: any,
	expected: Record<string, unknown>,
): boolean {
	return (
		!!actual &&
		Object.entries(expected).every(
			([k, v]) => Object.hasOwn(actual, k) && digest(actual[k]) === digest(v),
		)
	);
}
export function artifactBindingsValid(report: any): boolean {
	if (
		!report?.identity?.artifactDigests ||
		!Array.isArray(report.scores) ||
		!Array.isArray(report.recordProvenance)
	)
		return false;
	const artifacts = report.identity.artifactDigests;
	const ready = report.scores.filter((s: any) => s.kind === "ready");
	return (
		Object.keys(artifacts).length === ready.length &&
		report.scores.every((s: any) => {
			const p = report.recordProvenance.find((p: any) => p.taskId === s.taskId);
			if (s.kind !== "ready")
				return (
					s.artifactDigest === null &&
					!!p &&
					p.artifactDigest === null &&
					p.judgeArtifactDigest === null
				);
			return (
				typeof s.artifactDigest === "string" &&
				/^[a-f0-9]{64}$/.test(s.artifactDigest) &&
				artifacts[s.taskId] === s.artifactDigest &&
				p?.artifactDigest === s.artifactDigest &&
				p?.judgeArtifactDigest === s.artifactDigest &&
				p.judgeRecordPresent === true
			);
		})
	);
}
function currentView<
	T extends {
		n: number;
		scored: number;
		unscored: number;
		meanScore: number | null;
		scores: ScoreRow[];
	},
>(
	snapshot: T,
	sf: any,
	dir: string,
	suiteFile: string,
	profile: Profile,
	mode: "auto" | "off",
) {
	const suite = read(dir, suiteFile);
	const effective = mode === "off" ? "off" : sf?.identity?.queryReformulation;
	const expected = buildEvalIdentity({
		searchProfile: profile,
		suiteId: suite.id,
		suitePath: resolve(dir, suiteFile),
		seedPath: resolve("data/contextstill/seed.sqlite"),
		queryReformulation: effective === "on" ? "on" : "off",
		assemblyMode: "baseline",
		evidenceSupply: "natural",
		abstentionContrast: "off",
	});
	const bindings = artifactBindingsValid(sf);
	const expectedWithArtifacts = {
		...expected,
		artifactDigests: sf?.identity?.artifactDigests ?? null,
	};
	const matches =
		bindings &&
		!!sf &&
		(sf.queryReformulationMode ?? "off") === mode &&
		(effective === "on" || effective === "off") &&
		currentIdentityMatches(
			sf.identity,
			expectedWithArtifacts as unknown as Record<string, unknown>,
		);
	return {
		...snapshot,
		scored: matches ? snapshot.scored : 0,
		unscored: matches ? snapshot.unscored : snapshot.n,
		meanScore: matches ? snapshot.meanScore : null,
		scores: matches
			? snapshot.scores
			: snapshot.scores.map((s) => ({ ...s, score: null })),
		status: matches ? "current" : sf ? "stale" : "未測定",
		historicalSnapshot: snapshot,
	};
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
				validateScoreRows(sf, taskIds);
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
		const df = DEFAULT_RETRIEVAL_FILES[def.id];
		const dr = df ? read(dir, df) : null;
		let productDefault = null;
		if (dr) {
			if (dr.searchProfile !== "bm25" || dr.queryReformulationMode !== "auto")
				throw new Error(`${df}: not product default`);
			const rows = (dr.rows ?? []).filter((r: any) =>
				taskIds.includes(r.taskId),
			);
			if (rows.length !== taskIds.length)
				throw new Error(`${df}: ${rows.length}/${taskIds.length} rows`);
			const scoreName = DEFAULT_SCORE_FILES[def.id] ?? null;
			const sf = scoreName ? read(dir, scoreName) : null;
			if (sf) {
				validateScoreRows(sf, taskIds);
				if (sf.searchProfile !== "bm25" || sf.queryReformulationMode !== "auto")
					throw new Error(`${scoreName}: not product default`);
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
			productDefault = {
				retrievalSource: df,
				scoreSource: sf ? scoreName : null,
				queryReformulation: dr.identity?.queryReformulation ?? null,
				hitAt8: {
					hit: rows.filter((r: any) => r.allRequiredHitAt8).length,
					of: rows.length,
				},
				hitAt20Diagnostic: {
					hit: rows.filter((r: any) => r.allRequiredHitAt20Diagnostic).length,
					of: rows.length,
				},
				n: taskIds.length,
				scored,
				unscored: taskIds.length - scored,
				meanScore,
				scores,
			};
		}

		return {
			historicalSnapshot: true,
			currentCells: cells.map((c) =>
				currentView(
					c,
					read(dir, def.scoreFiles[c.profile]),
					dir,
					"suite-3axis.json",
					c.profile,
					"off",
				),
			),
			id: def.id,
			axis: def.axis,
			queryStyle: def.queryStyle,
			label: def.label,
			n: taskIds.length,
			cells,
			productDefault: productDefault
				? currentView(
						productDefault,
						DEFAULT_SCORE_FILES[def.id]
							? read(dir, DEFAULT_SCORE_FILES[def.id]!)
							: null,
						dir,
						"suite-3axis.json",
						"bm25",
						"auto",
					)
				: null,
		};
	});
	const diverseRetrieval = read(dir, "retrieval-diverse-default.json");
	const diverseScores = read(dir, "scores-diverse-default.json");
	let diverseCompanion = null;
	if (diverseRetrieval || diverseScores) {
		if (diverseRetrieval) {
			if (
				diverseRetrieval.searchProfile !== "bm25" ||
				diverseRetrieval.queryReformulationMode !== "auto"
			)
				throw new Error("retrieval-diverse-default.json: not product default");
		}
		if (diverseScores) {
			validateScoreRows(
				diverseScores,
				read(dir, "suite-diverse.json").tasks.map((t: any) => t.id),
			);
			if (
				diverseScores.searchProfile !== "bm25" ||
				diverseScores.queryReformulationMode !== "auto"
			)
				throw new Error("scores-diverse-default.json: not product default");
		}
		const rows = diverseRetrieval?.rows ?? [];
		const scoreRows = (diverseScores?.scores ?? []).map((s: any) => ({
			taskId: s.taskId as string,
			score: typeof s.score === "number" ? (s.score as number) : null,
			kind: s.kind ?? null,
			strategy: s.strategy ?? null,
			retrievalRank: s.retrievalRank ?? null,
			expectedSkillUsed: s.expectedSkillUsed ?? null,
		}));
		const scored = scoreRows.filter((s: ScoreRow) => s.score !== null).length;
		diverseCompanion = {
			suite: diverseScores?.suite ?? diverseRetrieval?.suite ?? null,
			n: scoreRows.length || rows.length,
			scored,
			unscored: (scoreRows.length || rows.length) - scored,
			meanScore:
				scoreRows.length > 0 && scored === scoreRows.length
					? Math.round(
							(scoreRows.reduce(
								(a: number, s: ScoreRow) => a + (s.score as number),
								0,
							) /
								scored) *
								100,
						) / 100
					: null,
			scores: scoreRows,
			hitAt8: rows.length
				? {
						hit: rows.filter((r: any) => r.allRequiredHitAt8).length,
						of: rows.length,
					}
				: null,
			hitAt20Diagnostic: rows.length
				? {
						hit: rows.filter((r: any) => r.allRequiredHitAt20Diagnostic).length,
						of: rows.length,
					}
				: null,
		};
	}
	return {
		suite: suite.id,
		totalTasks: slices.reduce((a, s) => a + s.n, 0),
		conditions: {
			handle: { searchProfile: "handle", ...CANONICAL_CONDITIONS },
			bm25: { searchProfile: "bm25", ...CANONICAL_CONDITIONS },
		},
		blendedMean: null,
		note: "SKILL score is a provisional 0-10 LLM judgment (not human-calibrated). Means are per slice x condition only; no blended mean across slices or axes. Provider tokens unmeasured. Diverse companion is not part of the 61-task total.",
		slices,
		diverseCompanion: diverseCompanion
			? currentView(
					diverseCompanion,
					diverseScores,
					dir,
					"suite-diverse.json",
					"bm25",
					"auto",
				)
			: null,
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
		"歴史的 snapshot（現行点ではない）: handle / bm25（いずれも assembly baseline・evidence natural・言い換えoff・棄権対比off）",
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
	L.push(
		"現行・製品既定（stale は未測定）（bm25・題名一致固定・言い換え auto＝日本語または題名非一致）。平均は区分ごと。全体平均は出さない。",
	);
	for (const s of b.slices)
		if (s.productDefault) {
			const pd = s.productDefault;
			const skill =
				pd.scored === 0
					? "SKILL 未測定"
					: `SKILL ${pd.scored}/${pd.n} 平均 ${pd.meanScore ?? "null（未採点あり）"}  [${pd.scores.map((x: ScoreRow) => x.score ?? "未").join(", ")}]`;
			L.push(
				`${s.id.padEnd(20)} ${String(s.n).padStart(2)} | ${skill}  hit@8 ${frac(pd.hitAt8)} (hit@20 ${frac(pd.hitAt20Diagnostic)})  言い換え ${pd.queryReformulation}`,
			);
		}
	if (b.diverseCompanion) {
		const d = b.diverseCompanion;
		L.push("");
		L.push(
			`別枠 suite-diverse（${d.n} 件、61 件には含めない）: SKILL ${d.scored}/${d.n} 平均 ${d.meanScore ?? "-"}  [${(d.scores as ScoreRow[]).map((x) => x.score ?? "未").join(", ")}]  hit@8 ${frac(d.hitAt8)} (hit@20 ${frac(d.hitAt20Diagnostic)})`,
		);
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
	for (const s of b.slices) {
		const pd = s.productDefault;
		if (!pd || pd.scored === 0) continue;
		L.push(
			`${s.id} 製品既定: 平均 ${pd.meanScore ?? "null（未採点あり）"}  [${pd.scores.map((x: ScoreRow) => x.score ?? "未").join(", ")}]`,
		);
		for (const x of pd.scores)
			L.push(
				`  ${x.taskId}: ${x.score ?? "未測定"}  ${x.kind ?? "-"}/${x.strategy ?? "-"}  rank ${x.retrievalRank ?? "-"}  expectedUsed ${x.expectedSkillUsed ?? "-"}`,
			);
	}
	if (b.diverseCompanion && b.diverseCompanion.scored > 0) {
		const d = b.diverseCompanion;
		L.push(
			`diverse 製品既定: 平均 ${d.meanScore ?? "null（未採点あり）"}  [${(d.scores as ScoreRow[]).map((x) => x.score ?? "未").join(", ")}]`,
		);
		for (const x of d.scores as ScoreRow[])
			L.push(
				`  ${x.taskId}: ${x.score ?? "未測定"}  ${x.kind ?? "-"}/${x.strategy ?? "-"}  rank ${x.retrievalRank ?? "-"}  expectedUsed ${x.expectedSkillUsed ?? "-"}`,
			);
	}
	const missing = [
		...b.slices.flatMap((s) =>
			s.cells
				.filter((c) => c.unscored)
				.map((c) => `${s.id} ${c.profile} ${c.unscored}/${c.n}`),
		),
		...b.slices
			.filter((s) => s.productDefault && s.productDefault.unscored)
			.map(
				(s) =>
					`${s.id} 製品既定 ${s.productDefault!.unscored}/${s.productDefault!.n}`,
			),
	];
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
