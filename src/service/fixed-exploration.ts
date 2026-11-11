import type {
	Build,
	GuidanceRequest,
	Policy,
	ReadyDecision,
} from "../contracts/types.js";
import type { ExplorationLanguage } from "../contracts/approved-skills.js";
import { assembleSkillBody } from "./skill-document.js";
import { renderSkillMarkdown } from "./skill-markdown.js";
import { requireThat } from "./identity.js";

/** Authored once. Task facts come from the separate request when a reader uses the SKILL. */
const workflow = `### Establish what can be checked

Read the accompanying task and extract the target, intended result, constraints, and one observable success condition. Inspect available version manifests, configuration, and environment metadata using read-only access. Write down each confirmed value with its source and mark unknown values. If the target or authorized observation scope cannot be identified, ask for the missing fact and stop before interacting with the system.

### Check the versioned primary sources

Find the upstream manual, release notes, or maintained source for the actual component and version. Look up the exact behavior named in the task, including prerequisites, limits, failure modes, and supported recovery. Record the source, version and the passage that supports each proposed action. Keep a discrepancy open until you can reproduce it or find an authoritative explanation. Stop before any action that depends on an unresolved discrepancy.

### Design one bounded experiment

Use synthetic inputs and a disposable copy, fixture, emulator or other authorized isolated target. Record the baseline first. Vary one task-specific condition and compare its observable result against that baseline. Include one failure or interruption that should prevent the result from being trusted. Before the experiment, record the input, the variable, the observation, the expected result for each case, and the cleanup or recovery step. Confirm the copy can be discarded or restored before changing it. For a planning request, describe the experiment and leave execution pending.

### Record the decision

Record the target and version, source passages, input, baseline, changed result, elapsed time or other relevant metric, and any effect outside the test boundary. Use redacted summaries where records could include private data. Compare each observed result with its expected value. Stop if the target differs from the plan, isolation or recovery cannot be verified, an unexpected side effect occurs, or the result is ambiguous. Report the first unresolved condition and the next read-only check. Advance to a broader test only after the bounded results and authorization support it.`;

const name = "safe-task-exploration";
const description =
	"Plan and begin bounded exploration when a task has no confirmed specialist procedure and can start with authorized read-only checks.";
const english = {
	kind: "ready",
	strategy: "provisional",
	sourceRefs: [],
	sections: [{ id: "workflow", body: workflow }],
	patches: [],
	requiredCapabilities: [],
	assumptions: [],
	verification: [
		"Record the exact target, version, authorized scope, and primary sources before proposing changes.",
		"Distinguish the planned experiment from observed results. Leave the outcome unverified until actual evidence supports it.",
	],
	name,
	title: "Explore an unfamiliar task safely",
	description,
	language: "en",
	localizedInstructions: workflow,
	domainAnchors: [
		{
			term: "target version",
			documentPointer: "Establish what can be checked",
		},
	],
	sourceReview: {
		assessment: "Owner-authored general exploration workflow.",
		flaggedItems: [],
	},
	nonSourceAdditions: [],
	document: {
		sections: [
			{
				kind: "principles",
				heading: "Scope",
				body: "This provisional workflow starts with observation and supports an isolated experiment. Use the authorization already granted. Stop before any action outside that scope and identify the authorization it requires. Keep production targets, customer data, and credentials outside the experiment.",
			},
			{ kind: "workflow", heading: "Procedure" },
			{ kind: "completion", heading: "Completion checks" },
		],
		provisionalNotice:
			"Exploration only. Results require observations from the target and version in the request.",
		references: [],
	},
} satisfies ReadyDecision;

const japaneseWorkflow = `### 対象と観測できる範囲を確かめる

依頼を読み、対象、目指す結果、制約、観測で判断できる成功条件を一つ書き出す。利用できる版情報、設定、実行環境を読み取り専用で確認する。確認できた値には確認元を添え、不明な値を記録する。対象や許可された観測範囲が特定できなければ、不足している情報を確認し、システムに触れる前に止まる。

### 対象の版に対応する一次資料を読む

実際の構成要素と版に対応する公式マニュアル、リリースノート、保守されているソースコードを探す。依頼で問われている挙動を調べ、前提条件、制限、失敗時の挙動、正式な復旧方法を確認する。提案する各操作について、資料名、対象版、根拠となる箇所を記録する。資料と観測に食い違いがあれば、再現できるか、一次資料で説明できるまで未解決として扱う。食い違いの解消が前提となる操作の前で止まる。

### 範囲を限定した実験を一つ設計する

合成データを使い、破棄できるコピー、テスト用のデータや環境、エミュレーターなど、許可された隔離環境を選ぶ。依頼の成功条件ごとに、調べる出力の項目、観測方法、合格と判断する値や状態を決める。期待値の根拠は、依頼、一次資料、またはこれから確かめる仮説のどれかを明記する。

実験計画には、同じ素材を使う基準ケースと、条件を一つ変える比較ケースを書く。各ケースに、最小の入力、固定する条件、変更する条件、観測箇所と期待値を記入する。結果を採用できなくなる失敗や中断も一つ挙げ、その判定と片付けまたは復旧手順を書く。変更の前に、コピーを破棄できるか、元に戻せることを確かめる。計画のみの依頼では、この比較計画を提示し、実行は保留する。

### 観測をもとに次の判断を記録する

対象と版、資料の該当箇所、入力、基準値、条件を変えたときの結果、所要時間などの指標、実験範囲外への影響を記録する。記録に機密情報が含まれ得る場合は、該当箇所を伏せた要約を使う。観測結果をケースごとの期待値と照合する。計画と対象が違う、隔離や復旧を確認できない、想定外の影響が出た、結果が曖昧という場合は止まる。最初の未解決事項と、次にできる読み取り専用の確認を報告する。範囲を広げるのは、今回の観測結果と許可の範囲が次の実験を支持する場合に限る。`;

const japanese = {
	...english,
	name: "safe-task-exploration-ja",
	title: "未知の課題を安全に調べる",
	description:
		"検証済みの専用手順が見つからず、許可された読み取り専用の確認から始められる課題で、探索を始めて隔離実験を計画する。",
	language: "ja",
	sections: [{ id: "workflow", body: japaneseWorkflow }],
	localizedInstructions: japaneseWorkflow,
	verification: [
		"変更を提案する前に、対象、版、許可された範囲、根拠となる一次資料を記録する。",
		"実験の計画と観測結果を区別し、実際の観測で裏付けられるまで結果は未検証とする。",
	],
	domainAnchors: [
		{ term: "対象と版", documentPointer: "対象と観測できる範囲を確かめる" },
	],
	sourceReview: {
		assessment: "提供元が作成した汎用の探索手順。",
		flaggedItems: [],
	},
	document: {
		sections: [
			{
				kind: "principles",
				heading: "適用範囲",
				body: "この暫定手順は観測から始め、隔離実験の設計に使う。すでに与えられた許可の範囲で進める。範囲を超える操作の前で止まり、必要な許可を明示する。本番環境、顧客データ、認証情報は実験に持ち込まない。",
			},
			{ kind: "workflow", heading: "手順" },
			{ kind: "completion", heading: "完了時の確認" },
		],
		provisionalNotice:
			"探索用の暫定手順。結果の確認には、依頼にある対象と版での観測が必要。",
		references: [],
	},
} satisfies ReadyDecision;

export const FIXED_EXPLORATION_REF = "skillsmith:fixed-exploration";

export function fixedExploration(
	request: Pick<GuidanceRequest, "task" | "environment" | "audience">,
	policy: Policy,
	language: ExplorationLanguage = "en",
) {
	const decision = language === "ja" ? japanese : english;
	const content: Build["content"] = {
		contractVersion: "skillsmith.v1",
		task: request.task,
		environment: request.environment,
		audience: request.audience,
		policy,
		body: "",
		decision: structuredClone(decision),
		dependencies: [],
	};
	// The caller supplies the bound request alongside this immutable SKILL.
	const presentation = {
		...content,
		task: { ...request.task, constraints: [] },
		policy: { ...policy, alreadyPresent: true },
	};
	content.body = presentation.body = assembleSkillBody(
		presentation,
		decision.localizedInstructions,
		decision.name,
	);
	const artifact = renderSkillMarkdown(presentation);
	requireThat(artifact.files && artifact.bundleDigest, "artifact_mismatch");
	return {
		content,
		artifact: {
			...artifact,
			files: artifact.files,
			bundleDigest: artifact.bundleDigest,
		},
	};
}
