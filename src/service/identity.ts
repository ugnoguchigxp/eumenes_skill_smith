import { createHash } from "node:crypto";
export class SkillSmithError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}
export function requireThat(ok: unknown, code: string): asserts ok {
	if (!ok) throw new SkillSmithError(code);
}
export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const result = JSON.stringify(value);
		requireThat(result !== undefined, "invalid_json");
		return result;
	}
	if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
	return (
		"{" +
		Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
			.join(",") +
		"}"
	);
}
export const digest = (value: unknown) =>
	createHash("sha256").update(canonical(value)).digest("hex");
export const bytes = (value: unknown) =>
	new TextEncoder().encode(canonical(value)).length;
