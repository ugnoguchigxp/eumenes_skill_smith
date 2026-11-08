import type { ExecutionContext } from "../../src/contracts/ports.js";
import type { SourcePort } from "./source.js";
/** Every fallback physical call is reserved; cooperating nested adapters avoid double count. */
export async function sourceOperation<T>(
	inner: SourcePort,
	context: ExecutionContext | undefined,
	operation: string,
	f: () => Promise<T>,
): Promise<T> {
	context?.signal.throwIfAborted();
	if (context && !inner.meteredCalls) await context.reserve("sourceCalls");
	context?.signal.throwIfAborted();
	const started = performance.now();
	let result: T;
	try {
		result = await f();
		context?.signal.throwIfAborted();
	} catch (error) {
		if (!inner.meteredCalls)
			context?.noteCall?.({
				kind: "sourceCalls",
				operation,
				outcome: "error",
				durationMs: performance.now() - started,
			});
		throw error;
	}
	if (!inner.meteredCalls)
		context?.noteCall?.({
			kind: "sourceCalls",
			operation,
			outcome: "ok",
			durationMs: performance.now() - started,
		});
	return result;
}
