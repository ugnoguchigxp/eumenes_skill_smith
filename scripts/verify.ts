const steps = [
	["bun", "run", "typecheck"],
	["bun", "run", "lint"],
	["bun", "run", "format:check"],
	["bun", "test", "src/test"],
	["bun", "test", "examples/contextstill/test"],
	["bun", "run", "build"],
	["bun", "run", "pack:core"],
];
for (const command of steps) {
	const result = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
	if ((await result.exited) !== 0) process.exit(1);
}

export {};
