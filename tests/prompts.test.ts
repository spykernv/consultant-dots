import { describe, expect, it } from "vitest";
import { buildUserMessage } from "@/lib/prompts/stages";
import { SYSTEM_PROMPT } from "@/lib/prompts/system";
import { PIPELINE_STAGE_IDS } from "@/lib/schemas";
import { STAGE_INPUT_SCHEMAS, StageRequestSchema } from "@/lib/schemas/api";
import {
  addInitiative,
  buildInputs,
  cycleScore,
  effectiveOptions,
  matrixChoicesOf,
  setVerdict,
  type Session,
} from "@/lib/store/machine";
import { fixture, sessionWith } from "./helpers";

describe("prompts", () => {
  const session = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true });

  it("keeps the system prompt static so it can be cached", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|undefined|\[object/);
    expect(SYSTEM_PROMPT).toContain("E10");
  });

  it("adds a revision block with the user's instruction and the previous output", () => {
    const inputs = buildInputs(session, "oral");
    const plain = buildUserMessage("oral", inputs);
    expect(plain).not.toContain("<revision>");

    const revised = buildUserMessage("oral", inputs, { steer: "Plus concis", previous: fixture("oral") });
    expect(revised).toContain('Their instruction: "Plus concis".');
    expect(revised).toContain(fixture("oral").opening);
    expect(revised.indexOf("<revision>")).toBeGreaterThan(revised.indexOf("<step>"));

    expect(buildUserMessage("oral", inputs, { steer: null, previous: null })).toContain("propose a different, sharper version");
  });

  it("gives the challenge the candidate answer and, when available, the reference analysis", () => {
    const answer = "Je propose un data lake pour tout centraliser, avec des API temps réel.";
    const early = buildUserMessage("challenge", buildInputs({ ...sessionWith(["classify"]), challengeAnswer: answer }, "challenge"));
    expect(early).toContain(`<candidate_answer>\n${answer}\n</candidate_answer>`);
    expect(early).not.toContain("<reference_analysis>");

    const late = buildUserMessage("challenge", buildInputs({ ...session, challengeAnswer: answer }, "challenge"));
    expect(late).toContain("<reference_analysis>");
    expect(late).toContain("<case_mapping>");
    expect(late).toContain("one valid answer among others");
    expect(early).not.toContain("<client_answers>\n");
  });

  it("tells the challenge what the client answered, apart from the working assumptions", () => {
    const [q1, q2] = fixture("questions").questions;
    const s = {
      ...session,
      challengeAnswer: "Vous m'avez dit que seuls des agrégats remontent au groupe : je pars sur une couche fédérée.",
      answers: { [q1.id]: " Seuls des agrégats remontent au groupe " },
      clientNotes: "- Le DAF tranche les définitions\n",
    };
    const message = buildUserMessage("challenge", buildInputs(s, "challenge"));
    expect(message).toContain(`- ${q1.id} — ${q1.question} → Réponse du client : Seuls des agrégats remontent au groupe\n`);
    expect(message).toContain(`- ${q2.id} — ${q2.question} → Hypothèse de travail, NON confirmée : ${q2.defaultAssumption}`);
    expect(message).toContain("Informations complémentaires du client :\n- C1 : Le DAF tranche les définitions");
    expect(message.indexOf("<client_answers>\n")).toBeGreaterThan(message.indexOf("<case_mapping>\n"));
    expect(message.indexOf("<client_answers>\n")).toBeLessThan(message.indexOf("<candidate_answer>\n"));
    expect(message).toContain("legitimate, not an assumption to flag");

    // A request sent by a tab opened before the challenge received the answers still parses.
    const { caseText, answer, classification, mapping, diagnostic, options, roadmap } = buildInputs(s, "challenge");
    const older = STAGE_INPUT_SCHEMAS.challenge.safeParse({ caseText, answer, classification, mapping, diagnostic, options, roadmap });
    expect(older.success).toBe(true);
    const fromOlder = buildUserMessage("challenge", older.data!);
    expect(fromOlder).toContain("<candidate_answer>");
    expect(fromOlder).not.toContain("<client_answers>\n");
  });

  it("asks an options regeneration to keep the pilot and the initiatives the candidate chose", () => {
    const inputs = buildInputs(session, "options");
    const regenerate = (s: Session, steer: string | null = null) =>
      buildUserMessage("options", inputs, { steer, previous: effectiveOptions(s), choices: matrixChoicesOf(s) });
    const initiatives = session.stages.options.data!.initiatives;
    const suggested = initiatives.find((i) => i.verdict === "pilot")!.name;
    const other = initiatives.findIndex((i) => i.verdict !== "pilot");

    // Untouched or only re-scored matrix: the pilot is the model's own, free to reconsider.
    for (const s of [session, cycleScore(session, 0, "value", 1)]) {
      const plain = regenerate(s);
      expect(plain).toContain("propose a different, sharper version");
      expect(plain).not.toContain("In their matrix");
      expect(plain).not.toContain("Keep ");
    }

    const chosen = addInitiative(setVerdict(session, other, "pilot"), "Mon idée");
    const revised = regenerate(chosen, "Plus concis");
    expect(revised).toContain(
      `In their matrix, they chose "${initiatives[other].name}" as the pilot instead of the suggested "${suggested}" and they added the initiatives "Mon idée"; the previous version includes these choices. Keep this pilot and these initiatives unless their instruction explicitly asks to change them.`,
    );
    expect(revised.indexOf("In their matrix")).toBeGreaterThan(revised.indexOf("Previous version"));

    const addedOnly = regenerate(addInitiative(session, "Mon idée"));
    expect(addedOnly).toContain("Keep these initiatives unless");
    expect(addedOnly).not.toContain("as the pilot");

    const choices = matrixChoicesOf(chosen);
    expect(buildUserMessage("options", inputs, { steer: "Plus concis", previous: null, choices })).not.toContain("In their matrix");
    expect(
      buildUserMessage("roadmap", buildInputs(chosen, "roadmap"), { steer: null, previous: fixture("roadmap"), choices }),
    ).not.toContain("In their matrix");
  });

  it("tells an options run after an upstream change which choices of the candidate to keep", () => {
    const inputs = buildInputs(session, "options");
    const initiatives = session.stages.options.data!.initiatives;
    const other = initiatives.findIndex((i) => i.verdict !== "pilot");
    const chosen = addInitiative(setVerdict(session, other, "pilot"), "Mon idée");

    const refreshed = buildUserMessage("options", inputs, null, matrixChoicesOf(chosen));
    expect(refreshed).toContain("<candidate_choices>");
    expect(refreshed).toContain(`keep "${initiatives[other].name}", under this exact name, as the pilot`);
    expect(refreshed).toContain(`added the initiatives "Mon idée"`);
    expect(refreshed.indexOf("<candidate_choices>")).toBeGreaterThan(refreshed.indexOf("<step>"));

    expect(buildUserMessage("options", inputs, null, null)).toBe(buildUserMessage("options", inputs));
    expect(buildUserMessage("options", inputs, null, matrixChoicesOf(cycleScore(session, 0, "value", 1)))).not.toContain(
      "<candidate_choices>",
    );
    // A regeneration already carries the choices in its revision block, never twice.
    const revised = buildUserMessage(
      "options",
      inputs,
      { steer: null, previous: effectiveOptions(chosen), choices: matrixChoicesOf(chosen) },
      matrixChoicesOf(chosen),
    );
    expect(revised).not.toContain("<candidate_choices>");
    expect(revised).toContain("In their matrix");
    expect(buildUserMessage("roadmap", buildInputs(chosen, "roadmap"), null, matrixChoicesOf(chosen))).not.toContain(
      "<candidate_choices>",
    );
  });

  it("parses regeneration requests sent without the matrix choices", () => {
    const request = { runId: "r1", mock: true, caseId: null, inputs: {}, steer: null, previous: null };
    expect(StageRequestSchema.parse(request).choices).toBeNull();
    const choices = { pilot: { chosen: "A", suggested: "B" }, added: ["C"] };
    expect(StageRequestSchema.parse({ ...request, choices }).choices).toEqual(choices);
  });

  it("sends the user's pilot choice downstream", () => {
    const s = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true });
    const initiatives = s.stages.options.data!.initiatives;
    const other = initiatives.find((i) => i.verdict !== "pilot")!;
    const edited = {
      ...s,
      matrix: {
        ...s.matrix,
        initiatives: initiatives.map((i) => ({ ...i, verdict: i === other ? ("pilot" as const) : i.verdict === "pilot" ? ("next" as const) : i.verdict })),
      },
    };
    const target = buildUserMessage("target", buildInputs(edited, "target"));
    expect(target).toContain(`"pilot":${JSON.stringify(other.name)}`);
    expect(target).toContain(`<candidate_decision>`);
    expect(target).toContain(`"${other.name}" is THE pilot`);
    expect(buildUserMessage("roadmap", buildInputs(edited, "roadmap"))).toContain("<candidate_decision>");
    expect(buildUserMessage("roadmap", buildInputs(s, "roadmap"))).not.toContain("<candidate_decision>");
  });
});
