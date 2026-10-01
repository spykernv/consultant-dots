import { interviewActions } from "@/lib/interview/client";
import type { InterviewState } from "@/lib/interview/schema";

type Progress = Pick<InterviewState, "status" | "messages" | "error">;

/**
 * A failed debrief usually leaves the client's goodbye last; one started after a failed turn ends on the candidate's
 * message, and only the error text tells it then, as for retry().
 */
export function debriefFailed({ status, messages, error }: Progress): boolean {
  if (status !== "error" || !messages.some((m) => m.role === "candidate")) return false;
  return messages.at(-1)?.role === "interviewer" || Boolean(error?.startsWith("Le débrief"));
}

/**
 * over: the conversation is finished, whether its debrief runs, is there or failed; live: the composer belongs on
 * screen, a failed turn included since « Réessayer » resumes it.
 */
export function phaseOf(interview: Progress) {
  const failed = debriefFailed(interview);
  const { status } = interview;
  const over = status === "debriefing" || status === "done" || failed;
  const live = status === "ready" || status === "waiting" || (status === "error" && interview.messages.length > 0 && !failed);
  return { over, live, debriefFailed: failed };
}

/** Candidate messages are the rounds: the one being written counts as the current round. */
export function roundsOf(interview: InterviewState) {
  const sent = interview.messages.filter((m) => m.role === "candidate").length;
  const current = Math.min(interview.maxRounds, Math.max(1, sent + (interview.status === "ready" ? 1 : 0)));
  const { over } = phaseOf(interview);
  return {
    sent,
    current,
    remaining: Math.max(0, interview.maxRounds - sent),
    label: over ? `${sent} tour${sent > 1 ? "s" : ""} joué${sent > 1 ? "s" : ""}` : `Tour ${current} / ${interview.maxRounds}`,
    // From an error too: ending is the way out of a turn that keeps failing.
    canEnd: !over && sent > 0 && (interview.status === "ready" || interview.status === "error"),
  };
}

export function confirmEnd(remaining: number) {
  const message =
    remaining > 0
      ? `Terminer l'entretien maintenant ? Il te reste ${remaining} tour${remaining > 1 ? "s" : ""}. Le client ne répondra plus et le débrief sera lancé.`
      : "Terminer l'entretien et lancer le débrief ?";
  if (window.confirm(message)) interviewActions.end();
}

/** The way out when a turn or the debrief keeps failing: the conversation stays readable in the workspace. */
export function confirmLeave() {
  const message =
    "Passer à l'analyse complète ? L'entretien s'arrête là : tu pourras relire la conversation dans la zone Raisonnement, mais plus la reprendre.";
  if (window.confirm(message)) interviewActions.showFullAnalysis();
}
