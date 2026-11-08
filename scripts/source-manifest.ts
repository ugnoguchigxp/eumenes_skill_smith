import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const sha = (value: Uint8Array | string) =>
	createHash("sha256").update(value).digest("hex");
export async function files(dir: string, prefix = ""): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(join(dir, prefix), {
		withFileTypes: true,
	})) {
		const path = prefix ? prefix + "/" + entry.name : entry.name;
		if (entry.isSymbolicLink()) throw new Error("package_symlink");
		if (entry.isDirectory()) paths.push(...(await files(dir, path)));
		else paths.push(path);
	}
	return paths.sort();
}
export async function hashes(dir: string, selected?: string[]) {
	const paths = selected ?? (await files(dir));
	return Object.fromEntries(
		await Promise.all(
			paths.map(async (p) => [p, sha(await readFile(join(dir, p)))]),
		),
	);
}
export async function inputs(root: string) {
	const sources = (await files(join(root, "src"))).filter(
		(p) => !p.startsWith("test/"),
	);
	const sourceHashes = await hashes(join(root, "src"), sources);
	return {
		sourceDigest: sha(JSON.stringify(Object.entries(sourceHashes))),
		buildInputDigest: sha(
			JSON.stringify(
				await hashes(root, [
					...sources.map((p) => "src/" + p),
					"package.json",
					"bun.lock",
					"tsconfig.json",
					"tsconfig.build.json",
					"scripts/build.ts",
					"scripts/source-manifest.ts",
				]),
			),
		),
	};
}
