/** Mechanical OpenAI strict-schema bridge: root object, required properties, nullable optional fields. */
type Schema = Record<string, unknown>;
export const strictSchemaInstructions =
	"Return the result in the provider schema's result field. Optional fields use null when omitted.";

export function strictProviderSchema(schema: Schema) {
	return {
		type: "object",
		properties: { result: providerSchema(schema) },
		required: ["result"],
		additionalProperties: false,
	};
}

export function providerSchema(schema: Schema): Schema {
	const out: Schema = {};
	for (const [key, value] of Object.entries(schema)) {
		if (["$schema", "default", "minLength", "maxLength"].includes(key))
			continue;
		// Provider rejects regex lookaround; the unchanged host schema still enforces it.
		if (
			key === "pattern" &&
			typeof value === "string" &&
			/\(\?(?:[=!]|<[=!])/.test(value)
		)
			continue;
		if (key === "properties") {
			const required = (schema.required ?? []) as string[];
			out.properties = Object.fromEntries(
				Object.entries(value as Record<string, Schema>).map(([name, item]) => [
					name,
					required.includes(name)
						? providerSchema(item)
						: { anyOf: [providerSchema(item), { type: "null" }] },
				]),
			);
			out.required = Object.keys(value as object);
		} else if (key === "required") continue;
		else if (key === "oneOf")
			out.anyOf = (value as Schema[]).map(providerSchema);
		else if (Array.isArray(value))
			out[key] = value.map((item) =>
				item && typeof item === "object" && !Array.isArray(item)
					? providerSchema(item as Schema)
					: item,
			);
		else if (value && typeof value === "object")
			out[key] = providerSchema(value as Schema);
		else out[key] = value;
	}
	if (
		schema.type === "string" &&
		!schema.pattern &&
		(typeof schema.minLength === "number" ||
			typeof schema.maxLength === "number")
	)
		out.pattern =
			"^[\\s\\S]{" +
			(schema.minLength ?? 0) +
			"," +
			(schema.maxLength ?? "") +
			"}$";
	return out;
}
/** Decode only declared optional-null fields; do not repair values, enums, arrays, or missing required fields. */
export function decodeProviderValue(value: unknown, schema: Schema): unknown {
	if (Array.isArray(schema.anyOf ?? schema.oneOf)) {
		const candidates = (schema.anyOf ?? schema.oneOf) as Schema[];
		const selected = candidates.find((candidate) => {
			const properties = candidate.properties as
				Record<string, Schema> | undefined;
			return (
				value &&
				typeof value === "object" &&
				properties &&
				Object.entries(properties).some(
					([key, item]) =>
						"const" in item && (value as Schema)[key] === item.const,
				)
			);
		});
		if (selected) return decodeProviderValue(value, selected);
	}
	if (Array.isArray(value) && schema.items)
		return value.map((item) =>
			decodeProviderValue(item, schema.items as Schema),
		);
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!schema.properties
	)
		return value;
	const properties = schema.properties as Record<string, Schema>;
	const required = (schema.required ?? []) as string[];
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key, item]) =>
					!(item === null && key in properties && !required.includes(key)),
			)
			.map(([key, item]) => [
				key,
				properties[key] ? decodeProviderValue(item, properties[key]) : item,
			]),
	);
}
