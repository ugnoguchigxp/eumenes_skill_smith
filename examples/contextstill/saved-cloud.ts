/** Backend-only evaluation bridge. Uses settings operations against an enforced read-only connection. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function savedCloud(root: string, connectionId: string) {
	const dbPath = resolve(
		root,
		process.env.EUMENES_DB || "data/eumenes.sqlite3",
	);
	const keyDir = resolve(
		root,
		process.env.EUMENES_KEY_DIR || join(dirname(dbPath), "keys"),
	);
	if (
		!process.env.EUMENES_SECRET_KEY &&
		!existsSync(join(keyDir, "settings.key"))
	)
		throw Error("existing_settings_key_required");
	const db = new Database(dbPath, { readonly: true });
	try {
		const module = await import(
			pathToFileURL(join(root, "api/domains/settings/index.ts")).href
		);
		const settings = await module.createSettings(
			{
				read: <T>(fn: (db: Database) => T) => fn(db),
				// Startup may check migrations, but the database itself forbids every write.
				write: async <T>(fn: (db: Database) => T) => fn(db),
			},
			{ dbPath, keyDir, env: process.env },
		);
		const snapshot = settings.get();
		const connection = snapshot.connections.find(
			(c: { id: string }) => c.id === connectionId,
		);
		if (
			!connection?.enabled ||
			(connection.kind && connection.kind !== "openai-compatible")
		)
			throw Error("saved_cloud_connection_unavailable");
		const credential = settings.credential(connection);
		if (!credential) throw Error("saved_cloud_credential_unavailable");
		const response = await fetch(
			connection.baseUrl.replace(/\/$/, "") + "/models",
			{
				headers: { authorization: "Bearer " + credential },
				signal: AbortSignal.timeout(15000),
			},
		);
		if (!response.ok) throw Error("cloud_catalog_http_" + response.status);
		const catalog = await response.json();
		return {
			baseUrl: connection.baseUrl as string,
			credential: credential as string,
			models: catalog.data.map((m: { id: string }) => m.id) as string[],
			settingsRevision: snapshot.revision as number,
		};
	} finally {
		db.close();
	}
}
