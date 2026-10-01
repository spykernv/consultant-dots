// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERVIEW_OPENING } from "@/lib/interview/client";
import { INTERVIEW_MAX_ROUNDS, type InterviewMessage, type InterviewState } from "@/lib/interview/schema";
import { INTERVIEW_SCORE_FORMULA, interviewScore } from "@/lib/interview/score";
import type { Session } from "@/lib/store/machine";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { InterviewRecap } from "@/components/interview/InterviewRecap";
import { InterviewView } from "@/components/interview/InterviewView";
import { debriefFailed, phaseOf, roundsOf } from "@/components/interview/phase";
import { fixture, sessionWith } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opening: InterviewMessage = { role: "interviewer", text: INTERVIEW_OPENING };
const candidate = (text: string): InterviewMessage => ({ role: "candidate", text });
const interviewer = (text: string): InterviewMessage => ({ role: "interviewer", text, reveal: [], action: "probe" });
const asked = [opening, candidate("Où vont les données ?")];
const goodbye = [...asked, interviewer("Merci, c'est clair pour moi.")];

function interviewOf(patch: Partial<InterviewState> = {}): InterviewState {
  return {
    status: "ready",
    maxRounds: INTERVIEW_MAX_ROUNDS,
    messages: [opening],
    revealed: [],
    debrief: null,
    notes: [],
    error: null,
    closed: false,
    ...patch,
  };
}

/** The demo case with its fact sheet built, and the interview at the given point. */
const sessionAt = (patch: Partial<InterviewState> = {}): Session =>
  sessionWith(["classify", "frame", "questions"], { mock: true, caseId: "data-platform", interview: interviewOf(patch) });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

const text = () => container?.textContent ?? "";
const button = (label: string) => [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(label));
const click = (label: string) => act(() => button(label)!.click());
const panelHeader = (title: string) =>
  [...(container?.querySelectorAll("section > header") ?? [])].find((h) => h.querySelector("h2")?.textContent === title);

beforeEach(() => {
  sessionStorage.clear();
  // jsdom lays nothing out; the views scroll the latest message and the debrief into view.
  Element.prototype.scrollIntoView = vi.fn();
  // Leaving for the analysis starts its stages: they wait here instead of reaching a server.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  actions.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("where the interview stands", () => {
  it("keeps a failed turn live, since « Réessayer » asks the client again", () => {
    const failed = interviewOf({ status: "error", messages: asked, error: "Le client n'a pas pu répondre : délai dépassé." });
    expect(phaseOf(failed)).toEqual({ over: false, live: true, debriefFailed: false });
    expect(roundsOf(failed)).toMatchObject({ sent: 1, label: "Tour 1 / 8", canEnd: true });
  });

  it("treats a failed debrief as over: the client has already said goodbye", () => {
    const failed = interviewOf({ status: "error", messages: goodbye, error: "Le débrief n'a pas pu être généré : délai dépassé." });
    expect(phaseOf(failed)).toEqual({ over: true, live: false, debriefFailed: true });
    expect(roundsOf(failed)).toMatchObject({ label: "1 tour joué", canEnd: false });
  });

  it("tells a debrief started after a failed turn by its error, the candidate's message being last", () => {
    expect(debriefFailed(interviewOf({ status: "error", messages: asked, error: "Le débrief a été interrompu. Relance-le." }))).toBe(
      true,
    );
    expect(debriefFailed(interviewOf({ status: "error", messages: asked, error: null }))).toBe(false);
  });

  it("offers no conversation while the fact sheet is built or when its preparation failed", () => {
    expect(phaseOf(interviewOf({ status: "preparing", messages: [] }))).toEqual({ over: false, live: false, debriefFailed: false });
    expect(phaseOf(interviewOf({ status: "error", messages: [], error: "La préparation a échoué." }))).toEqual({
      over: false,
      live: false,
      debriefFailed: false,
    });
    expect(roundsOf(interviewOf())).toMatchObject({ current: 1, label: "Tour 1 / 8", canEnd: false });
    expect(phaseOf(interviewOf({ status: "debriefing", messages: goodbye })).over).toBe(true);
    expect(phaseOf(interviewOf({ status: "done", messages: goodbye })).over).toBe(true);
  });
});

describe("the interview screen", () => {
  it("does not look like a live interview once the debrief failed, and lets the candidate leave for the analysis", () => {
    useSession.setState(
      sessionAt({ status: "error", messages: goodbye, error: "Le débrief n'a pas pu être généré : Limite d'usage atteinte." }),
      true,
    );
    render(createElement(InterviewView));

    expect(container!.querySelector("textarea")).toBeNull();
    expect(button("Terminer")).toBeUndefined();
    expect(text()).toContain("1 tour joué");
    expect(text()).not.toContain("restant");
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "Le débrief n'a pas pu être généré : Limite d'usage atteinte.",
    );
    // Once over, the client's moves can be named without breaking the role play.
    expect(text()).toContain("Le client a demandé des précisions");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    click("Passer à l'analyse complète");
    expect(confirm).toHaveBeenCalledOnce();
    expect(useSession.getState().interview).toMatchObject({ closed: true, status: "error" });
    expect(useSession.getState().gatePassed).toBe(true);
  });

  it("keeps a failed turn resumable, with the round and the way out in the conversation header", () => {
    useSession.setState(sessionAt({ status: "error", messages: asked, error: "Le client n'a pas pu répondre : délai dépassé." }), true);
    render(createElement(InterviewView));

    expect(container!.querySelector("textarea")?.disabled).toBe(true);
    expect(panelHeader("Entretien client")?.textContent).toContain("Tour 1 / 8");
    expect(button("Réessayer")).toBeDefined();
    // The phone header and the sidebar both offer it, enabled from the error.
    expect([...container!.querySelectorAll("button")].filter((b) => b.textContent?.includes("Terminer"))).toHaveLength(2);
    expect(button("Terminer")!.disabled).toBe(false);
    expect(text()).not.toContain("Le client a demandé");

    // Cancelling the confirmation leaves the interview where it was.
    vi.spyOn(window, "confirm").mockReturnValue(false);
    click("Passer à l'analyse complète");
    expect(useSession.getState().interview).toMatchObject({ closed: false, status: "error" });
  });

  it("announces the debrief as it runs, then shows the score with its formula in plain text", () => {
    // Mounted first: a debrief found running on mount is one a reload cut short, which the view marks as interrupted.
    useSession.setState(sessionAt({ messages: goodbye }), true);
    render(createElement(InterviewView));
    act(() => useSession.setState((s) => ({ interview: { ...s.interview!, status: "debriefing" } })));
    expect(container!.querySelector('[role="status"]')?.textContent).toContain("Débrief en cours");

    const debrief = fixture("challenge");
    act(() => useSession.setState((s) => ({ interview: { ...s.interview!, status: "done", debrief, revealed: ["Q2"] } })));
    const score = interviewScore(useSession.getState())!;
    const region = container!.querySelector('[role="region"]')!;
    expect(region.getAttribute("aria-labelledby")).toBe(region.querySelector("h3")?.id);
    expect(document.activeElement).toBe(region.querySelector("h3"));
    expect(region.textContent).toContain(`${score.score}/ 100`);
    expect(region.textContent).toContain(INTERVIEW_SCORE_FORMULA);
    expect(region.textContent).toContain(`Réponses clés obtenues : 1 / ${score.keyQuestions.total}`);
    expect(button("Voir l'analyse complète")).toBeDefined();
  });
});

describe("the interview once left for the analysis", () => {
  const debrief = fixture("challenge");

  it("stays readable in the workspace, without a way back to the analysis it already opened", () => {
    useSession.setState(sessionAt({ status: "done", messages: goodbye, revealed: ["Q2"], debrief, closed: true }), true);
    render(createElement(InterviewRecap));
    const score = interviewScore(useSession.getState())!;
    expect(text()).toContain("Ton entretien client");
    expect(text()).toContain(`${score.score} / 100 · 1 tour`);
    expect(container!.querySelector('[role="region"]')).toBeNull();

    click("Ton entretien client");
    expect(container!.querySelector('[role="region"]')?.textContent).toContain("Débrief de l'entretien");
    expect(button("Voir l'analyse complète")).toBeUndefined();
    // Read-only: opening the recap does not pull the focus away from the workspace.
    expect(document.activeElement).toBe(document.body);

    click("Relire la conversation");
    expect(text()).toContain("Où vont les données ?");
    expect(text()).toContain("Le client a demandé des précisions");
    expect(container!.querySelector('[aria-live]')).toBeNull();
  });

  it("keeps the conversation of an interview left before its debrief", () => {
    useSession.setState(
      sessionAt({ status: "error", messages: asked, error: "Entretien quitté avant la fin.", closed: true }),
      true,
    );
    render(createElement(InterviewRecap));
    expect(text()).toContain("1 tour");
    expect(text()).not.toContain("/ 100");
    click("Ton entretien client");
    expect(text()).toContain("Pas de débrief pour cet entretien.");
    expect(text()).toContain("Entretien quitté avant la fin.");
    expect(button("Réessayer")).toBeUndefined();
  });

  it("shows nothing for an interview still running or left before the first message", () => {
    useSession.setState(sessionAt({ status: "done", messages: goodbye, debrief }), true);
    render(createElement(InterviewRecap));
    expect(text()).toBe("");

    act(() => useSession.setState(sessionAt({ status: "ready", closed: true }), true));
    expect(text()).toBe("");
  });
});
