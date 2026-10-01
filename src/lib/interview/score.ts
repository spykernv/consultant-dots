import { CHALLENGE_LEVELS, type ChallengeLevel } from "@/lib/schemas/challenge";
import type { Session } from "@/lib/store/machine";

export type InterviewScore = {
  score: number;
  keyQuestions: { asked: string[]; missed: string[]; total: number };
  level: ChallengeLevel | null;
  blockingFlags: number;
  roundsUsed: number;
  maxRounds: number;
};

/** The debrief's level on 100. */
const LEVEL_POINTS: Record<ChallengeLevel, number> = {
  a_retravailler: 25,
  correct: 50,
  solide: 75,
  impressionnant: 95,
};

const BLOCKING_PENALTY = 5;

export const INTERVIEW_SCORE_FORMULA =
  "Score sur 100 = 60 % du niveau du débrief (à retravailler 25, correct 50, solide 75, impressionnant 95) " +
  "+ 40 % de la part des questions clés dont tu as obtenu la réponse du client " +
  `− ${BLOCKING_PENALTY} points par point bloquant (sévérité haute), arrondi et borné entre 0 et 100.`;

/**
 * Computed by the code from the debrief and what the client revealed, so that it can be checked by hand:
 * the model judges the answer, it never sets the score. Null until the debrief exists.
 */
export function interviewScore(s: Session): InterviewScore | null {
  const interview = s.interview;
  const debrief = interview?.debrief;
  if (!interview || !debrief) return null;

  const ids = (s.stages.questions.data?.questions ?? []).map((q) => q.id);
  const asked = interview.revealed.filter((id) => ids.includes(id));
  const missed = ids.filter((id) => !asked.includes(id));
  const level = (CHALLENGE_LEVELS as readonly string[]).includes(debrief.level) ? debrief.level : null;
  const blockingFlags = debrief.flags.filter((f) => f.severity === "high").length;
  const coverage = ids.length > 0 ? asked.length / ids.length : 0;
  const raw = 0.6 * (level ? LEVEL_POINTS[level] : 0) + 0.4 * 100 * coverage - BLOCKING_PENALTY * blockingFlags;

  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    keyQuestions: { asked, missed, total: ids.length },
    level,
    blockingFlags,
    roundsUsed: interview.messages.filter((m) => m.role === "candidate").length,
    maxRounds: interview.maxRounds,
  };
}
