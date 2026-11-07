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
	try {
		const result = await f();
		if (!inner.meteredCalls)
			context?.noteCall?.({ kind: "sourceCalls", operation, outcome: "ok" });
		return result;
	} catch (error) {
		if (!inner.meteredCalls)
			context?.noteCall?.({ kind: "sourceCalls", operation, outcome: "error" });
		throw error;
	}
}
