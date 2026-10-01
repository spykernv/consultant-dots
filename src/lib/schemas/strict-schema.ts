import { z } from "zod";

export type JsonSchema = { [key: string]: unknown };

// Keywords Claude's structured output can't enforce; counts and lengths stay in descriptions.
const DROPPED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "minItems" && typeof value === "number" && value > 1) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as JsonSchema).map(([name, sub]) => [name, strictify(sub)]),
      );
      continue;
    }
    out[key] = strictify(value);
  }

  if (out.type === "object") {
    const properties = (out.properties ?? {}) as JsonSchema;
    out.additionalProperties = false;
    out.required = Object.keys(properties);
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw" });
  return strictify(raw) as JsonSchema;
}

export function schemaStats(schema: JsonSchema) {
  let unions = 0;
  let objectsMissingRequired = 0;
  const keywords = new Set<string>();

  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as JsonSchema;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "properties" && value && typeof value === "object") {
        Object.values(value as JsonSchema).forEach(walk);
        continue;
      }
      keywords.add(key);
      walk(value);
    }
    if (Array.isArray(obj.anyOf) || Array.isArray(obj.type)) unions++;
    if (obj.type === "object") {
      const props = Object.keys((obj.properties ?? {}) as JsonSchema);
      const required = (obj.required ?? []) as string[];
      if (props.some((p) => !required.includes(p))) objectsMissingRequired++;
    }
  };
  walk(schema);
  return { unions, objectsMissingRequired, keywords };
}
