export function requiredBunVersion(packageManager: string | undefined) {
	return packageManager?.match(/^bun@(\d+\.\d+\.\d+)/)?.[1] ?? null;
}
export function bunAtLeast(actual: string, want: string) {
	const parts = (v: string) => v.split(".").map((n) => Number(n));
	const a = parts(actual),
		w = parts(want);
	for (let i = 0; i < 3; i++) {
		const x = a[i] ?? 0,
			y = w[i] ?? 0;
		if (x > y) return true;
		if (x < y) return false;
	}
	return true;
}
