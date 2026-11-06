import { z } from "zod";

/** Eval record of what belongs in content identity vs execution constraints. */
export const cacheIdentityManifestSchema = z.strictObject({
	contentKeys: z.array(z.string()).min(1),
	executionOnlyKeys: z.array(z.string()).min(1),
	generatorKeys: z.array(z.string()).min(1),
	method: z.literal("cache_identity_manifest_v1"),
});
export type CacheIdentityManifest = z.infer<typeof cacheIdentityManifestSchema>;

export const defaultCacheIdentityManifest = (): CacheIdentityManifest =>
	cacheIdentityManifestSchema.parse({
		contentKeys: [
			"task",
			"acceptance",
			"constraints",
			"environment",
			"audience",
			"policy",
			"scope",
			"instructions",
		],
		executionOnlyKeys: ["requestId", "deadlineAt", "prior"],
		generatorKeys: ["instructions", "contractVersion"],
		method: "cache_identity_manifest_v1",
	});
