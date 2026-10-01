// @vitest-environment jsdom
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import mermaid from "mermaid";
import { NODE_KINDS, type DiagramSpec } from "@/lib/schemas/diagram";
import type { Initiative } from "@/lib/schemas/options";
import { pivotsToMermaid } from "@/lib/diagram/pivots";
import { priorityToMermaid } from "@/lib/diagram/priority";
import { escapeLabel, toMermaid } from "@/lib/diagram/to-mermaid";
import { sanitizeDiagram } from "@/lib/pipeline/normalize";
import { fixture } from "./helpers";

const sample: DiagramSpec = {
  direction: "LR",
  groups: [
    { id: "fr", label: "Filiale France", kind: "zone", parentId: null },
    { id: "de", label: "Filiale Allemagne", kind: "zone", parentId: null },
    { id: "de_hr", label: "Données RH", kind: "local_boundary", parentId: "de" },
    { id: "empty", label: "Vide", kind: "zone", parentId: null },
  ],
  nodes: [
    { id: "end", label: "DG (\"vision\") <groupe>", kind: "actor", groupId: null, status: "existing" },
    { id: "erp_fr", label: "ERP France", kind: "system", groupId: "fr", status: "existing" },
    { id: "hr", label: "Paie & RH #1", kind: "data", groupId: "de_hr", status: "assumption" },
    { id: "x", label: "Reporting Excel manuel | 10 jours", kind: "process", groupId: null, status: "existing" },
    { id: "kpi", label: "KPIs incohérents", kind: "pain_point", groupId: null, status: "existing" },
    { id: "rgpd", label: "RGPD", kind: "constraint", groupId: null, status: "existing" },
    { id: "gov", label: "Gouvernance data", kind: "control", groupId: null, status: "new" },
    { id: "dash", label: "Dashboard groupe", kind: "output", groupId: null, status: "retired" },
  ],
  edges: [
    { from: "erp_fr", to: "x", label: "export", style: "dashed" },
    { from: "hr", to: "x", label: null, style: "solid" },
    { from: "x", to: "kpi", label: "saisie", style: "thick" },
    { from: "de", to: "gov", label: null, style: "solid" },
    { from: "ghost", to: "kpi", label: null, style: "solid" },
    { from: "empty", to: "kpi", label: null, style: "solid" },
  ],
};

describe("toMermaid", () => {
  const code = toMermaid(sanitizeDiagram(sample));

  it("maps model ids to safe ids so reserved words like `end` cannot break the chart", () => {
    expect(code).not.toMatch(/\bend\(/);
    expect(code).toContain('n1(["');
  });

  it("escapes quotes, angle brackets, pipes and hashes in labels", () => {
    expect(code).toContain("#quot;vision#quot;");
    expect(code).toContain("#lt;groupe#gt;");
    expect(code).toContain("#35;1");
    expect(code).not.toContain("manuel | 10");
  });

  it("nests groups, marks local boundaries and drops empty groups and unknown refs", () => {
    expect(code).toContain("🔒 reste local");
    expect(code).not.toContain("Vide");
    expect(code).not.toMatch(/ghost/);
    expect(code).toMatch(/class g\d+ g_local/);
  });

  it("applies status classes after kind classes", () => {
    expect(code.indexOf("class n3 s_assumption")).toBeGreaterThan(code.indexOf("k_data"));
  });

  it("produces code mermaid can parse", async () => {
    await expect(mermaid.parse(code)).resolves.toBeTruthy();
  });

  it("truncates long labels", () => {
    expect(escapeLabel("x".repeat(80)).length).toBeLessThanOrEqual(42);
  });
});

const initiative = (name: string, value: number, feasibility: number, verdict: Initiative["verdict"] = "next") =>
  ({ name, value, feasibility, risk: 2, timeToValue: 3, reuse: 3, verdict, comment: "" }) as Initiative;

describe("blank labels", () => {
  it("name a blank node after its kind and leave a blank zone untitled, so the chart still parses", async () => {
    const code = toMermaid({
      direction: "LR",
      groups: [
        { id: "z", label: "", kind: "zone", parentId: null },
        { id: "l", label: "   ", kind: "local_boundary", parentId: null },
      ],
      nodes: NODE_KINDS.map((kind, i) => ({
        id: kind,
        label: i % 2 ? " \n " : "",
        kind,
        groupId: i === 0 ? "z" : i === 1 ? "l" : null,
        status: "existing" as const,
      })),
      edges: [{ from: "actor", to: "system", label: "  ", style: "solid" }],
    });
    expect(code).not.toContain('""');
    expect(code).toContain('n1(["Acteur"])');
    expect(code).toContain('n4("Processus")');
    expect(code).toContain('subgraph g1[" "]');
    expect(code).toContain('subgraph g2["🔒 reste local"]');
    expect(code).toContain("n1 --> n2");
    await expect(mermaid.parse(code)).resolves.toBeTruthy();
  });

  it("keep the pivots tree readable and parseable", async () => {
    const options = fixture("options");
    const code = pivotsToMermaid({
      options: options.options,
      recommendation: {
        optionId: options.recommendation.optionId,
        pivots: [{ basis: "", question: " ", assumed: "", ifInstead: "  ", thenOptionId: null, consequence: "" }],
      },
    })!;
    expect(code).toContain('p1("?")');
    expect(code).toContain('p1a["Hypothèse actuelle"]');
    expect(code).toContain('p1b["Autre réponse"]');
    await expect(mermaid.parse(code)).resolves.toBeTruthy();
    await expect(mermaid.parse(pivotsToMermaid(options)!)).resolves.toBeTruthy();
  });

  it("name an unnamed initiative in the quadrant chart", async () => {
    const code = priorityToMermaid([initiative(" ", 4, 2, "pilot"), initiative("", 2, 4)]);
    expect(code).toContain('"Initiative sans nom (pilote)": [0.30, 0.70]');
    expect(code).toContain('"Initiative sans nom": [0.70, 0.30]');
    await expect(mermaid.parse(code)).resolves.toBeTruthy();
    await expect(mermaid.parse(priorityToMermaid(fixture("options").initiatives))).resolves.toBeTruthy();
  });
});

describe("quadrant coordinates", () => {
  it("never writes 1.00 when a crowded corner spreads past 0.995", async () => {
    const code = priorityToMermaid(Array.from({ length: 12 }, (_, i) => initiative(`I${i + 1}`, 5, 5)));
    expect(code).not.toMatch(/[[ ]1\.\d/);
    expect(code).toMatch(/: \[(?:0\.\d\d|1|0), 1\]/);
    await expect(mermaid.parse(code)).resolves.toBeTruthy();
  });
});

describe("recorded fixture diagrams", () => {
  const root = path.join(process.cwd(), "fixtures", "mock");
  const files = existsSync(root)
    ? readdirSync(root).flatMap((dir) =>
        ["currentState.json", "target.json"]
          .map((f) => path.join(root, dir, f))
          .filter((f) => existsSync(f)),
      )
    : [];

  if (files.length === 0) it.skip("no recorded fixtures yet", () => undefined);
  else
    it.each(files)("%s compiles and parses", async (file) => {
      const data = JSON.parse(readFileSync(file, "utf8")) as { diagram: DiagramSpec };
      await expect(mermaid.parse(toMermaid(sanitizeDiagram(data.diagram)))).resolves.toBeTruthy();
    });
});
