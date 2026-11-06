import { expect, test } from "bun:test";
import { bunAtLeast, requiredBunVersion } from "../../scripts/bun-version.js";

test("verify bun version gate accepts 1.4.4 and rejects older patch", () => {
	expect(requiredBunVersion("bun@1.4.4")).toBe("1.4.4");
	expect(requiredBunVersion(undefined)).toBeNull();
	expect(bunAtLeast("1.4.4", "1.4.4")).toBe(true);
	expect(bunAtLeast("1.4.5", "1.4.4")).toBe(true);
	expect(bunAtLeast("1.4.2", "1.4.4")).toBe(false);
	expect(bunAtLeast("1.3.9", "1.4.4")).toBe(false);
});
