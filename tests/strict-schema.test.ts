import { describe, expect, it } from "vitest";
import { STAGE_IDS, STAGE_SCHEMAS } from "@/lib/schemas";
import { schemaStats, toStrictJsonSchema } from "@/lib/schemas/strict-schema";

const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "description",
  "minItems",
]);

describe("strict JSON schemas sent to Claude Code", () => {
  it.each(STAGE_IDS)("%s only uses supported keywords, requires every field and stays under 16 unions", (stage) => {
    const stats = schemaStats(toStrictJsonSchema(STAGE_SCHEMAS[stage]));
    expect([...stats.keywords].filter((k) => !ALLOWED_KEYWORDS.has(k))).toEqual([]);
    expect(stats.objectsMissingRequired).toBe(0);
    expect(stats.unions).toBeLessThanOrEqual(16);
  });

  it("keeps enums, numeric score literals and nullable fields", () => {
    const schema = toStrictJsonSchema(STAGE_SCHEMAS.options) as {
      properties: Record<string, { items?: { properties: Record<string, unknown> }; properties?: Record<string, unknown> }>;
    };
    const initiative = schema.properties.initiatives.items!.properties;
    expect(initiative.value).toMatchObject({ enum: [1, 2, 3, 4, 5] });
    expect(initiative.verdict).toMatchObject({ enum: ["pilot", "next", "later", "avoid"] });
    const optionId = schema.properties.recommendation.properties!.optionId as { type: string[] };
    expect(optionId.type).toEqual(["string", "null"]);
  });

  it("adds additionalProperties: false to every object", () => {
    const json = JSON.stringify(toStrictJsonSchema(STAGE_SCHEMAS.roadmap));
    const objects = json.match(/"type":"object"/g)?.length ?? 0;
    const closed = json.match(/"additionalProperties":false/g)?.length ?? 0;
    expect(closed).toBe(objects);
  });
});
