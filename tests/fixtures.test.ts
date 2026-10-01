import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PIPELINE_STAGE_IDS, STAGE_IDS, STAGE_SCHEMAS } from "@/lib/schemas";

const root = path.join(process.cwd(), "fixtures", "mock");
const cases = existsSync(root) ? readdirSync(root) : [];

describe("recorded demo fixtures", () => {
  it("include a complete demo case", () => {
    expect(cases).toContain("data-platform");
    for (const stage of PIPELINE_STAGE_IDS) {
      expect(existsSync(path.join(root, "data-platform", `${stage}.json`))).toBe(true);
    }
  });

  const files = cases.flatMap((caseId) =>
    STAGE_IDS.map((stage) => ({ caseId, stage, file: path.join(root, caseId, `${stage}.json`) })).filter((f) =>
      existsSync(f.file),
    ),
  );

  it.each(files)("$caseId/$stage matches its schema", ({ stage, file }) => {
    const result = STAGE_SCHEMAS[stage].safeParse(JSON.parse(readFileSync(file, "utf8")));
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues.slice(0, 3))).toBe(true);
  });
});
