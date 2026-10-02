import { MAX_CHALLENGE_CHARS, type Clarification, type StageInputs } from "@/lib/schemas/api";
import type { Session } from "@/lib/store/machine";
import type { FactSheet, InterviewObservation, InterviewState } from "./schema";

/**
 * What the interview shares between the app (client.ts, in the browser) and the eval (src/lib/eval, in node): the
 * opening, the fact sheet, how a turn's notes merge, and the debrief's inputs. No store, no fetch: safe on the server.
 */

/** Written by the code, not the model: the client opens every interview the same way, then lets the candidate lead. */
export const INTERVIEW_OPENING =
  "Bonjour, merci de prendre ce temps avec nous. Vous avez lu le contexte : c'est un sujet important pour nous et j'aimerais avoir votre regard. Comment aborderiez-vous le sujet ?";

/** Tells the challenge that the answer is a conversation, and keeps even a short one above its minimum length. */
export const DEBRIEF_HEADER = "Mes messages au client pendant l'entretien, dans l'ordre :";

/**
 * The challenge's own blocks, zero-width or spaced variants included. The candidate's messages go inside
 * <candidate_answer>, followed by the instructions: a tag typed there could close it and add a <step> of its own.
 */
const CHALLENGE_TAGS =
  /<[\s\u200B-\u200D\uFEFF]*(\/?)[\s\u200B-\u200D\uFEFF]*(case|playbook|case_mapping|client_answers|reference_analysis|candidate_answer|step)\b/gi;

const neutralize = (text: string) => text.replace(CHALLENGE_TAGS, "‹$1$2");

export const candidateTexts = (interview: InterviewState) =>
  interview.messages.filter((m) => m.role === "candidate").map((m) => m.text);

/** One note per reflex for the whole interview: a turn's note on a reflex already noted is dropped. */
export function mergeObservations(previous: InterviewObservation[], added: InterviewObservation[]): InterviewObservation[] {
  const merged = [...previous];
  for (const observation of added) {
    if (!merged.some((o) => o.reflex === observation.reflex)) merged.push(observation);
  }
  return merged;
}

/** What the simulated client knows: the case's facts and an answer to each clarification question, never the analysis. */
export function buildFactSheet(s: Session): FactSheet | null {
  const { frame, questions } = s.stages;
  if (frame.status !== "done" || !frame.data || questions.status !== "done" || !questions.data) return null;
  return {
    facts: frame.data.facts.slice(0, 20).map(({ id, text }) => ({ id, text })),
    // An answer the user typed for this case wins over the working assumption.
    clientAnswers: questions.data.questions
      .slice(0, 8)
      .map(({ id, question, defaultAssumption }) => ({ id, question, answer: s.answers[id]?.trim() || defaultAssumption })),
  };
}

/**
 * The candidate's messages, numbered. Eight long ones exceed what the challenge accepts: the earlier ones are then
 * cut, the longest first. The closing one, usually the recommendation the debrief judges most, stays whole: at
 * MAX_CANDIDATE_CHARS it still leaves the seven others over 600 characters each.
 */
export function debriefAnswer(texts: string[]): string {
  const safe = texts.map(neutralize);
  const render = (cap: number) =>
    [
      DEBRIEF_HEADER,
      ...safe.map((text, i) => {
        const keep = i === safe.length - 1 ? text.length : cap;
        return `${i + 1}. ${text.length > keep ? `${text.slice(0, keep).trimEnd()}…` : text}`;
      }),
    ].join("\n");
  let cap = Math.max(0, ...safe.slice(0, -1).map((text) => text.length));
  while (cap > 0 && render(cap).length > MAX_CHALLENGE_CHARS) cap = Math.max(0, cap - 10);
  return render(cap).slice(0, MAX_CHALLENGE_CHARS);
}

/** The regular challenge, run on what the candidate said; only the answers the client gave count as answered. */
export function debriefInputs(s: Session, interview: InterviewState): StageInputs["challenge"] {
  const answer = debriefAnswer(candidateTexts(interview));
  const questions = s.stages.questions.data;
  const told = new Map((buildFactSheet(s)?.clientAnswers ?? []).map((a) => [a.id, a.answer]));
  const clarifications: Clarification[] = (questions?.questions ?? []).map((q) =>
    interview.revealed.includes(q.id)
      ? { questionId: q.id, status: "answered", answer: (told.get(q.id) ?? q.defaultAssumption).slice(0, 2000) }
      : { questionId: q.id, status: "open", answer: "" },
  );
  return {
    caseText: s.caseText,
    answer,
    classification: s.stages.classify.data,
    mapping: s.stages.frame.data,
    diagnostic: null,
    options: null,
    roadmap: null,
    questions,
    clarifications,
    clientNotes: "",
  };
}
