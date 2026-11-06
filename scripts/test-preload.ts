globalThis.fetch = Object.assign(
	async () => {
		throw new Error("network_forbidden_in_fixture");
	},
	{
		preconnect: () => {
			throw new Error("network_forbidden_in_fixture");
		},
	},
);
Bun.serve = (() => {
	throw new Error("server_forbidden_in_fixture");
}) as typeof Bun.serve;
export {};
