import { describe, expect, it } from "vitest";
import { PIPELINE_STAGE_IDS } from "@/lib/schemas";
import type { StageId } from "@/lib/schemas";
import { sessionToMarkdown, staleSections } from "@/lib/export/markdown";
import { exportFilename } from "@/lib/export/download";
import {
  buildInputs,
  hashInputsOf,
  initialSession,
  resetStale,
  setVerdict,
  setWeight,
  type Session,
  type StageStatus,
} from "@/lib/store/machine";
import { SAMPLE_CASES } from "@/lib/samples";
import { fixture, sessionWith } from "./helpers";

const NOW = new Date(2026, 8, 27, 14, 5);

describe("sessionToMarkdown", () => {
  const full = sessionWith([...PIPELINE_STAGE_IDS], {
    gatePassed: true,
    answers: { Q1: "Le CODIR veut piloter la marge." },
    notes: { oral: "Commencer par la marge.", case: "  " },
  });
  const md = sessionToMarkdown(full, NOW);

  it("covers the whole reasoning in interview order", () => {
    const order = [
      "## Énoncé",
      "## Type de case",
      "## Cadrage",
      "## Questions de clarification",
      "## Diagnostic",
      "## Schéma de l'existant",
      "## Options",
      "## Priorisation",
      "## Pièges à éviter",
      "## Cible",
      "## Roadmap",
      "## Restitution orale",
      "## Mes notes",
    ];
    const positions = order.map((heading) => md.indexOf(heading));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("embeds the current state, the pivots, the target and the value × feasibility matrix as mermaid blocks", () => {
    expect(md.match(/```mermaid\nflowchart/g)).toHaveLength(3);
    expect(md.match(/```mermaid\nquadrantChart/g)).toHaveLength(1);
    expect(md.indexOf("### Ce qui ferait changer la recommandation")).toBeGreaterThan(md.indexOf("### Recommandation"));
  });

  it("compares the options before the recommendation, constraints first", () => {
    const comparison = fixture("options").comparison;
    const table = md.slice(md.indexOf("### Comparaison des options"), md.indexOf("### Recommandation"));
    expect(table).toContain("| **Contrainte** " + comparison.constraints[0].label);
    expect(table).toContain("✗ " + comparison.constraints[0].fits[0].note);
    expect(table).toContain("| **Critère** " + comparison.criteria[0].label + " | 4/5 |");
  });

  it("keeps client answers and working assumptions distinct", () => {
    expect(md).toContain("**Réponse du client :** Le CODIR veut piloter la marge.");
    expect(md).toContain(`Hypothèse de travail : ${fixture("questions").questions[1].defaultAssumption}`);
  });

  it("includes non-empty notes only", () => {
    expect(md).toContain("### Oral & challenge\n\nCommencer par la marge.");
    expect(md).not.toContain("### Le case\n");
  });

  it("reflects the user's prioritization and weights", () => {
    const initiatives = full.stages.options.data!.initiatives;
    const other = initiatives.findIndex((i) => i.verdict !== "pilot");
    const edited = sessionToMarkdown(setWeight(setVerdict(full, other, "pilot"), "value", 3), NOW);
    expect(edited).toContain("priorisation ajustée par moi");
    expect(edited).toContain("Score = 3×valeur");
    expect(edited).toMatch(new RegExp(`\\| ${initiatives[other].name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|.*\\| Pilote \\|`));
  });

  it("renders a partial session without crashing", () => {
    const early = sessionToMarkdown(sessionWith(["classify"]), NOW);
    expect(early).toContain("## Type de case");
    expect(early).not.toContain("## Diagnostic");
    expect(sessionToMarkdown({ ...initialSession(), caseText: "Un case." }, NOW)).toContain("# Business case");
  });

  it("flags the sections generated for another pilot right under their heading", () => {
    expect(md).not.toContain("Section à mettre à jour");
    const other = full.stages.options.data!.initiatives.findIndex((i) => i.verdict !== "pilot");
    const edited = sessionToMarkdown(setVerdict(full, other, "pilot"), NOW);
    const flagged = [...edited.matchAll(/^(## .+)\n\n\*\*⚠️ Section à mettre à jour :\*\*/gm)].map((m) => m[1]);
    expect(flagged).toEqual(["## Cible", "## Roadmap", `## Restitution orale (${fixture("oral").duration})`]);
  });

  it("still flags them once their update is launched, until it finishes", () => {
    const other = full.stages.options.data!.initiatives.findIndex((i) => i.verdict !== "pilot");
    const refreshed = resetStale(setVerdict(full, other, "pilot"));
    // The target was stopped and the roadmap failed after starting on the new pilot; the oral still waits for both.
    const s: Session = {
      ...refreshed,
      stages: {
        ...refreshed.stages,
        target: { ...refreshed.stages.target, status: "interrupted", inputHash: hashInputsOf("target", buildInputs(refreshed, "target")) },
        roadmap: { ...refreshed.stages.roadmap, status: "error", inputHash: hashInputsOf("roadmap", buildInputs(refreshed, "roadmap")) },
      },
    };
    const edited = sessionToMarkdown(s, NOW);
    const flagged = [...edited.matchAll(/^(## .+)\n\n\*\*⚠️ Section à mettre à jour :\*\* (.+)$/gm)].map((m) => [m[1], m[2]]);
    const note = "nouvelle version lancée mais pas terminée : ce contenu est celui de la version précédente.";
    expect(flagged).toEqual([
      ["## Cible", note],
      ["## Roadmap", note],
      [`## Restitution orale (${fixture("oral").duration})`, note],
    ]);
    expect(edited).toContain(`### Pilote : ${fixture("roadmap").pilot.initiative}`);
  });

  it("flags everything built on a clarification edited after the gate", () => {
    const edited = sessionToMarkdown({ ...full, answers: { Q1: "Le CODIR veut piloter le BFR." } }, NOW);
    const flagged = [...edited.matchAll(/^(## .+)\n\n\*\*⚠️ Section à mettre à jour :\*\*/gm)].map((m) => m[1]);
    expect(flagged).toEqual([
      "## Diagnostic",
      "## Schéma de l'existant",
      "## Options",
      "## Priorisation",
      "## Pièges à éviter",
      "## Cible",
      "## Roadmap",
      `## Restitution orale (${fixture("oral").duration})`,
    ]);
    expect(edited).toMatch(/^## Diagnostic\n\n\*\*⚠️ Section à mettre à jour :\*\* .+\.\n\n### Arbre de raisonnement$/m);
  });

  it("says when my answer changed after it was challenged", () => {
    const answer = SAMPLE_CASES[0].flawedAnswer;
    const challenged = sessionWith([...PIPELINE_STAGE_IDS, "challenge"], { gatePassed: true, challengeAnswer: answer });
    const note = "## Challenge de ma réponse\n\n**⚠️ Section à mettre à jour :** ta réponse a changé";
    expect(sessionToMarkdown(challenged, NOW)).toContain("## Challenge de ma réponse\n### Ma réponse");
    expect(sessionToMarkdown({ ...challenged, challengeAnswer: `${answer} Et le RGPD.` }, NOW)).toContain(note);
    expect(sessionToMarkdown({ ...challenged, challengeAnswer: "Un data lake." }, NOW)).toContain(note);
  });

  it("escapes pipes inside table cells", () => {
    const s = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true });
    s.stages.roadmap.data = { ...s.stages.roadmap.data!, risks: [{ risk: "A | B", impact: "x", mitigation: "y" }] };
    expect(sessionToMarkdown(s, NOW)).toContain("| A \\| B | x | y |");
  });
});

describe("staleSections", () => {
  const answer = SAMPLE_CASES[0].flawedAnswer;
  const challenged = sessionWith([...PIPELINE_STAGE_IDS, "challenge"], { gatePassed: true, challengeAnswer: answer });
  const other = challenged.stages.options.data!.initiatives.findIndex((i) => i.verdict !== "pilot");
  const INPUTS = "générée avant tes dernières modifications (clarification, pilote ou section en amont).";
  const RERUN = "nouvelle version lancée mais pas terminée : ce contenu est celui de la version précédente.";

  it("tells the PDF report which sections to flag and why, as the Markdown export does", () => {
    expect([...staleSections(challenged)]).toEqual([]);
    expect([...staleSections(setVerdict(challenged, other, "pilot"))]).toEqual([
      ["target", INPUTS],
      ["roadmap", INPUTS],
      ["oral", INPUTS],
    ]);
    const shortened = staleSections({ ...challenged, challengeAnswer: "Un data lake." });
    expect([...shortened.keys()]).toEqual(["challenge"]);
    expect(shortened.get("challenge")).toMatch(/^ta réponse a changé depuis ce challenge/);
  });

  it("keeps flagging the sections built for the previous pilot while their update is waiting, running, stopped or failed", () => {
    const refreshed = resetStale(setVerdict(challenged, other, "pilot"));
    expect([...staleSections(refreshed)]).toEqual([
      ["target", RERUN],
      ["roadmap", RERUN],
      ["oral", RERUN],
    ]);
    // Each run takes the new inputs' hash when it starts and keeps the previous result until it finishes.
    const started = (s: Session, stage: StageId, status: StageStatus): Session => ({
      ...s,
      stages: { ...s.stages, [stage]: { ...s.stages[stage], status, inputHash: hashInputsOf(stage, buildInputs(s, stage)) } },
    });
    for (const status of ["running", "interrupted", "error"] as const) {
      expect([...staleSections(started(refreshed, "target", status)).keys()]).toEqual(["target", "roadmap", "oral"]);
    }
    const failed = started(started(refreshed, "target", "interrupted"), "roadmap", "error");
    expect([...staleSections(failed).values()]).toEqual([RERUN, RERUN, RERUN]);
    // A challenge of the edited answer that did not finish leaves the previous remarks under the new answer.
    const rechallenged = started({ ...challenged, challengeAnswer: `${answer} Et le RGPD.` }, "challenge", "error");
    expect([...staleSections(rechallenged)]).toEqual([["challenge", RERUN]]);
  });

  it("flags nothing for a stage that has not produced anything yet", () => {
    const first = sessionWith(["classify", "frame", "questions"], { gatePassed: true });
    const running = { ...first, stages: { ...first.stages, diagnose: { ...first.stages.diagnose, status: "running" as const } } };
    expect([...staleSections(running)]).toEqual([]);
  });
});

describe("exportFilename", () => {
  it("builds a readable, dated file name from the case type", () => {
    expect(exportFilename(sessionWith(["classify"]), ".md", NOW)).toBe("consultant-dots-data-platform-20260927-1405.md");
    expect(exportFilename(initialSession(), "-cible.mmd", NOW)).toBe("consultant-dots-case-20260927-1405-cible.mmd");
  });
});
