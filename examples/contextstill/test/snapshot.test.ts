import { expect, test } from "bun:test";

test("public snapshot exporter: WAL consistency, private-data exclusion and file protection", async () => {
	const process = Bun.spawn(
		["python3", new URL("./snapshot_test.py", import.meta.url).pathname],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [code, output, errors] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (code !== 0) throw new Error(output + errors);
	expect(code).toBe(0);
});
