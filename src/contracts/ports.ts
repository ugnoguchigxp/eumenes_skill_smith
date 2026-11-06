import type { ServiceLimits } from "./limits.js";
import type {
	Authority,
	Build,
	Delivery,
	Evidence,
	Executed,
	GuidanceRequest,
	Policy,
	Prepared,
	Proposal,
	Report,
	RequestRecord,
	VersionRef,
} from "./types.js";
export interface Repository<Tx> {
	reflection(tx: Tx, ref: string): import("./types.js").Reflection | null;
	reflectionByReport(
		tx: Tx,
		scope: string,
		digest: string,
	): import("./types.js").Reflection | null;
	putReflection(
		tx: Tx,
		row: import("./types.js").Reflection,
		expected: number | null,
	): void;
	blocked(tx: Tx, ref: string): boolean;
	request(tx: Tx, ref: string): RequestRecord | null;
	requestByKey(tx: Tx, scope: string, requestId: string): RequestRecord | null;
	putRequest(tx: Tx, row: RequestRecord, expected: number | null): void;
	openRequests(tx: Tx, limit: number): RequestRecord[];
	build(tx: Tx, ref: string): Build | null;
	cached(tx: Tx, scope: string, key: string): Build | null;
	putBuild(tx: Tx, build: Build): void;
	revokeBuild(tx: Tx, ref: string): void;
	link(tx: Tx, owner: string, source: string): void;
	dependants(tx: Tx, source: string): string[];
	erase(tx: Tx, ref: string): void;
	bindUse(tx: Tx, scope: string, buildRef: string, executionRef: string): void;
	hasUse(
		tx: Tx,
		scope: string,
		buildRef: string,
		executionRef: string,
	): boolean;
	putDelivery(tx: Tx, delivery: Delivery): void;
	deliveries(tx: Tx, limit: number): Delivery[];
	ackDelivery(tx: Tx, id: string): void;
	report(tx: Tx, scope: string, executionRef: string): Report | null;
	reportReceipt(
		tx: Tx,
		scope: string,
		reportId: string,
	): { digest: string; revision: number } | null;
	putReport(tx: Tx, report: Report): void;
	proposal(tx: Tx, ref: string): Proposal | null;
	putProposal(tx: Tx, proposal: Proposal, expected: number | null): void;
}
export interface Ports<Tx> {
	repository: Repository<Tx>;
	authority: {
		valid(tx: Tx, authority: Authority, sourceRefs: string[]): boolean;
	};
	registry: {
		search(
			query: string,
			authority: Authority,
			limit: number,
			signal: AbortSignal,
		): Promise<import("./types.js").EvidenceCard[]>;
		read(
			ref: string,
			authority: Authority,
			signal: AbortSignal,
		): Promise<Evidence>;
		current(tx: Tx, authority: Authority, refs: VersionRef[]): boolean;
	};
	source?: {
		/** Cards plus search-wide warnings/degraded/truncated as reported by the source. */
		search(
			query: string,
			limit: number,
			signal: AbortSignal,
		): Promise<import("./types.js").SourceSearch>;
		get(ref: string, signal: AbortSignal): Promise<Evidence>;
		validate(
			refs: Pick<Evidence, "ref" | "version" | "external">[],
			signal: AbortSignal,
		): Promise<boolean>;
	};
	inference: {
		complete(
			input: {
				system: string;
				data: unknown;
				schema: Record<string, unknown>;
				deadlineAt: number;
				maxOutputTokens: number;
				requestRef: string;
			},
			signal: AbortSignal,
		): Promise<{
			value: unknown;
			receipt: string;
			inputTokens: number | null;
			outputTokens: number | null;
		}>;
		validReceipt(tx: Tx, receipt: string): boolean;
	};
	policy: {
		resolve(tx: Tx, request: GuidanceRequest, authority: Authority): Policy;
		current(tx: Tx, version: VersionRef): boolean;
	};
	jobs: {
		enqueue(
			tx: Tx,
			input: { requestRef: string; epoch: number; deadlineAt: number },
		): string;
		cancel(tx: Tx, jobRef: string): void;
	};
	now(): number;
	id(): string;
	/** Optional overrides; omitted fields keep package defaults. */
	limits?: Partial<ServiceLimits>;
}
export interface ExecutionContext {
	signal: AbortSignal;
	/** Each reservation must commit before any external call. */
	reserve(kind: "modelCalls" | "sourceCalls"): Promise<void>;
}
export interface SkillSmith<Tx> {
	submit(
		tx: Tx,
		input: unknown,
		authority: Authority,
	): import("./types.js").Reply;
	activate(
		tx: Tx,
		ref: string,
		authority: Authority,
		parentReleased: boolean,
	): boolean;
	prepare(
		tx: Tx,
		ref: string,
		epoch: number,
		authority: Authority,
	): Prepared | null;
	execute(prepared: Prepared, context: ExecutionContext): Promise<Executed>;
}
