import { afterEach } from "bun:test";
import { fixture as createFixture } from "./fixture-host.js";
export { ready } from "./fixture-host.js";
export type { Fixture } from "./fixture-host.js";
const open = new Set<ReturnType<typeof createFixture>>();
afterEach(() => {
	for (const f of open) f.dispose();
});
export function fixture(...args: Parameters<typeof createFixture>) {
	const f = createFixture(...args),
		close = f.dispose;
	let disposed = false;
	f.dispose = () => {
		if (disposed) return;
		disposed = true;
		open.delete(f);
		close();
	};
	open.add(f);
	return f;
}
