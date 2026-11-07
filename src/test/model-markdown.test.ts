import { test, expect } from "bun:test";
import { validateModelMarkdown } from "../service/model-markdown.js";

const unsafe = [
	"../../secret",
	"/etc/passwd",
	"%2e%2e/private",
	"references/%2E%2E/%2e%2e/private",
	"%2fetc/passwd",
	"%2f%2fexample.test/private",
	"references/%5c..%5cprivate",
	"%66ile%3a/private",
	"%252e%252e/private",
	"references/%00private",
	"references/%ZZ.md",
	"C:/private",
];
for (const kind of ["link", "image", "definition"] as const) {
	test(`model Markdown rejects unsafe local ${kind} targets`, () => {
		for (const url of unsafe) {
			const body =
				kind === "definition"
					? `[label]: ${url}\n\n[label]`
					: `${kind === "image" ? "!" : ""}[label](${url})`;
			expect(() => validateModelMarkdown("title", body)).toThrow(
				"skill_model_url",
			);
		}
	});
}
test("model Markdown permits local bundle links, anchors, queries and existing external schemes", () => {
	for (const url of [
		"references/checks.md",
		"./detail.md#checks",
		"#checks",
		"?view=compact",
		"references/checks.md?q=../#part",
		"https://example.test/a/../b",
		"mailto:reader@example.test",
	]) {
		expect(() =>
			validateModelMarkdown("title", `[label](${url})`),
		).not.toThrow();
	}
	expect(() =>
		validateModelMarkdown("title", "```sh\ncat ../../example\n```"),
	).not.toThrow();
});
