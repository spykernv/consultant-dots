import { describe, expect, it } from "vitest";
import { PIPELINE_STAGE_IDS } from "@/lib/schemas";
import { buildSynthesis } from "@/lib/export/synthesis";
import { setVerdict } from "@/lib/store/machine";
import { fixture, sessionWith } from "./helpers";

describe("buildSynthesis", () => {
  const full = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true });

  it("sums the analysis up in five lines, problem first, success measure last", () => {
    const lines = buildSynthesis(full);
    expect(lines.map((l) => l.label)).toEqual(["Enjeu", "Diagnostic", "Recommandation", "Pilote", "Succès mesuré par"]);
    expect(lines[0].text).toContain(fixture("frame").reformulation.replace(/\.$/, ""));
    expect(lines.every((l) => /[.!?…]$/.test(l.text))).toBe(true);
  });

  it("describes the recorded pilot with its scope and leads the success line with business KPIs", () => {
    const roadmap = fixture("roadmap");
    const lines = buildSynthesis(full);
    expect(lines[3].text).toContain(`${roadmap.pilot.initiative} : ${roadmap.pilot.scope.replace(/\.$/, "")}`);
    const business = roadmap.kpis.find((k) => k.type === "business")!;
    const adoption = roadmap.kpis.find((k) => k.type === "adoption")!;
    expect(lines[4].text.startsWith(`${business.name} : `)).toBe(true);
    expect(lines[4].text).toContain(` ; ${adoption.name} : `);
  });

  it("drops the analysis ids from the summary", () => {
    const text = buildSynthesis(full).map((l) => l.text).join(" ");
    expect(text).not.toMatch(/\([FAQC]\d+/);
  });

  it("names the pilot the user chose in the matrix, without the old pilot's scope", () => {
    const initiatives = full.stages.options.data!.initiatives;
    const other = initiatives.findIndex((i) => i.verdict !== "pilot");
    const pilot = buildSynthesis(setVerdict(full, other, "pilot")).find((l) => l.label === "Pilote")!;
    expect(pilot.text).toBe(`${initiatives[other].name}.`);
  });

  it("only keeps the lines the analysis already supports", () => {
    expect(buildSynthesis(sessionWith(["classify"]))).toEqual([]);
    expect(buildSynthesis(sessionWith(["classify", "frame", "questions"])).map((l) => l.label)).toEqual(["Enjeu"]);
  });
});
