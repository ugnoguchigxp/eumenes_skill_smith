import { test, expect } from "bun:test";
import { z } from "zod";
import { baselineTurnSchema } from "../../../src/eval/index.js";
import { providerSchema, decodeProviderValue } from "../provider-schema.js";

test("unsupported provider lookaround stays enforced by the original host schema", () => {
	const original = z.string().regex(/^(?!bad$)[a-z]+$/);
	const schema = z.toJSONSchema(original);
	expect(providerSchema(schema).pattern).toBeUndefined();
	expect(() => original.parse(decodeProviderValue("bad", schema))).toThrow();
	expect(original.parse(decodeProviderValue("good", schema))).toBe("good");
});

test("provider length constraints use a structural pattern without accepting empty queries", () => {
	const schema = providerSchema({ type: "string", minLength: 1, maxLength: 3 });
	const pattern = new RegExp(schema.pattern as string);
	expect(pattern.test("")).toBe(false);
	expect(pattern.test("a\nb")).toBe(true);
	expect(pattern.test("abcd")).toBe(false);
});

test("provider bridge preserves required nullable values and decodes only optional fields", () => {
	const schema = z.strictObject({
		required: z.string().nullable(),
		optional: z.string().optional(),
		nested: z.array(z.strictObject({ optional: z.number().optional() })),
	});
	const json = z.toJSONSchema(schema);
	const adapted = providerSchema(json);
	const required = adapted.required as string[];
	expect(required.sort()).toEqual(["nested", "optional", "required"]);
	const decoded = decodeProviderValue(
		{ required: null, optional: null, nested: [{ optional: null }] },
		json,
	);
	expect(schema.parse(decoded)).toEqual({ required: null, nested: [{}] });
	expect(() =>
		schema.parse(decodeProviderValue({ required: 3, nested: [] }, json)),
	).toThrow();
});
test("provider union selects by schema discriminator, without repairing invalid model values", () => {
	const schema = z.toJSONSchema(baselineTurnSchema);
	const valid = decodeProviderValue(
		{ kind: "disclose", items: [{ ref: "ref", sectionIds: null }] },
		schema,
	);
	expect(baselineTurnSchema.parse(valid)).toEqual({
		kind: "disclose",
		items: [{ ref: "ref" }],
	});
	expect(() =>
		baselineTurnSchema.parse(
			decodeProviderValue({ kind: "compose", items: [] }, schema),
		),
	).toThrow();
	expect(() =>
		baselineTurnSchema.parse(
			decodeProviderValue(
				{ kind: "disclose", items: [[{ ref: "ref" }]] },
				schema,
			),
		),
	).toThrow();
});
