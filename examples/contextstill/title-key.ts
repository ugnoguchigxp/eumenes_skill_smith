/** Mechanical pin identity, not translation or semantic matching. */
export const titleKey = (text: string) =>
	text
		.normalize("NFKC")
		.trim()
		.replace(/[A-Z]/g, (c) => c.toLowerCase());
