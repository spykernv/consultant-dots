// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERVIEW_OPENING } from "@/lib/interview/client";
import {
  INTERVIEW_MAX_ROUNDS,
  type InterviewMessage,
  type InterviewObservation,
  type InterviewState,
  type ToolTrace,
} from "@/lib/interview/schema";
import { INTERVIEW_SCORE_FORMULA, interviewScore } from "@/lib/interview/score";
import type { Session } from "@/lib/store/machine";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { InterviewRecap } from "@/components/interview/InterviewRecap";
import { InterviewView } from "@/components/interview/InterviewView";
import { debriefFailed, phaseOf, roundsOf } from "@/components/interview/phase";
import { visibleLookups } from "@/components/interview/Transcript";
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

const note = (patch: Partial<InterviewObservation> = {}): InterviewObservation => ({
  reflex: "E1",
  severity: "high",
  quote: "un data lake groupe",
  note: "Propose une architecture avant d'avoir établi les besoins.",
  round: 1,
  ...patch,
});
const notes = [
  note(),
  note({ reflex: "E2", severity: "medium", quote: "migrer vers le cloud", note: "Fait du cloud l'objectif lui-même.", round: 2 }),
];
/** The list under a section title of the debrief. */
/** Small gray text stays readable on white (WCAG AA): slate-500 or darker, never the lighter grays. */
const expectReadableGray = (element: Element | undefined) => {
  expect(element).toBeDefined();
  expect(element!.className).toMatch(/\btext-slate-(?:500|600|700|800|900)\b/);
  expect(element!.className).not.toMatch(/\btext-slate-(?:50|100|200|300|400)\b/);
};

const sectionItems = (title: string) => {
  const heading = [...(container?.querySelectorAll("h3") ?? [])].find((h) => h.textContent === title);
  return [...(heading?.parentElement?.parentElement?.querySelectorAll("li") ?? [])];
};

describe("what the client checked before replying", () => {
  const calls: ToolTrace[] = [
    { name: "get_client_answer", target: "Q2", ok: true },
    { name: "lookup_fact", target: "F3", ok: true },
    { name: "check_quote", target: "un data lake", ok: true },
    { name: "record_observation", target: "E1", ok: true },
    { name: "get_client_answer", target: "Q7", ok: false },
    { name: "lookup_fact", target: "F42", ok: false },
    { name: "check_quote", target: "jamais écrit", ok: false },
    { name: "record_observation", target: "E2", ok: false },
  ];
  const checked: InterviewMessage = {
    role: "interviewer",
    text: "Les données RH restent en Allemagne.",
    reveal: ["Q2"],
    action: "clarify",
    tools: calls,
  };
  const bubble = (said: string) => [...(container?.querySelectorAll("ol > li") ?? [])].find((li) => li.textContent?.includes(said))!;

  it("names the fiche's entries and the verified quotes, never the private notes or a refused call", () => {
    const messages = [opening, candidate("Où vont les données ? Je pense à un data lake."), checked];
    useSession.setState(sessionAt({ messages, observations: [note()] }), true);
    render(createElement(InterviewView));

    const line = bubble("Les données RH restent en Allemagne.");
    expect(line.textContent).toContain("Fiche client : réponse Q2 · fait F3 · citation vérifiée");
    expect(line.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expectReadableGray([...line.querySelectorAll("span")].find((s) => s.textContent?.startsWith("Fiche client")));
    for (const hidden of ["E1", "E2", "Q7", "F42", "jamais écrit", "observation"]) {
      expect(text()).not.toContain(hidden);
    }
    // What the client noted waits for the debrief.
    expect(text()).not.toContain("Notes du client");
    expect(text()).not.toContain(note().note);
  });

  it("adds no line under a reply whose calls the candidate may not see, nor under one without calls", () => {
    const privateOnly: InterviewMessage = {
      ...checked,
      text: "Pourquoi un data lake ?",
      tools: [calls[3], calls[4], calls[5], calls[6]],
    };
    const messages = [opening, candidate("Un data lake."), privateOnly, candidate("Pour tout centraliser."), interviewer("D'accord.")];
    useSession.setState(sessionAt({ messages }), true);
    render(createElement(InterviewView));
    expect(text()).not.toContain("Fiche client");
    expect(text()).not.toContain("citation");
    expect(bubble("Pourquoi un data lake ?").querySelector("svg")).toBeNull();
  });

  it("keeps the private notes out of the transcript once the interview is over too", () => {
    useSession.setState(
      sessionAt({
        status: "done",
        messages: [...asked, checked],
        revealed: ["Q2"],
        debrief: fixture("challenge"),
        observations: [note()],
        closed: true,
      }),
      true,
    );
    render(createElement(InterviewRecap));
    click("Ton entretien client");
    click("Relire la conversation");
    const line = bubble("Les données RH restent en Allemagne.");
    expect(line.textContent).toContain("Fiche client : réponse Q2 · fait F3 · citation vérifiée");
    expect(line.textContent).not.toContain("E1");
  });

  it("groups the entries by kind, once each, and counts the quotes", () => {
    expect(
      visibleLookups([
        { name: "get_client_answer", target: "Q2", ok: true },
        { name: "lookup_fact", target: "F1", ok: true },
        { name: "get_client_answer", target: " q2 ", ok: true },
        { name: "get_client_answer", target: "Q5", ok: true },
        { name: "check_quote", target: "tout centraliser", ok: true },
        { name: "check_quote", target: "par API", ok: true },
      ]),
    ).toBe("Fiche client : réponses Q2, Q5 · fait F1 · 2 citations vérifiées");
    expect(visibleLookups([{ name: "lookup_fact", target: "F4", ok: true }, { name: "lookup_fact", target: "F2", ok: true }])).toBe(
      "Fiche client : faits F4, F2",
    );
    expect(visibleLookups([{ name: "check_quote", target: "par API", ok: true }])).toBe("citation vérifiée");
    expect(visibleLookups([{ name: "record_observation", target: "E1", ok: true }])).toBeNull();
    expect(visibleLookups([])).toBeNull();
    expect(visibleLookups(undefined)).toBeNull();
  });
});

describe("the client's notes in the debrief", () => {
  const debrief = fixture("challenge");
  const NOTES_TITLE = "Notes du client pendant l'entretien";

  it("lists what the client noted, between the flags and the strengths, without changing the score", () => {
    useSession.setState(sessionAt({ status: "done", messages: goodbye, revealed: ["Q2"], debrief, observations: notes }), true);
    render(createElement(InterviewView));
    const region = container!.querySelector('[role="region"]')!.textContent!;
    expect(region).toContain(NOTES_TITLE);
    expect(region).toContain("relevées en direct, citations vérifiées dans tes messages");
    expect(region.indexOf("Autres points à corriger")).toBeLessThan(region.indexOf(NOTES_TITLE));
    expect(region.indexOf(NOTES_TITLE)).toBeLessThan(region.indexOf("Points forts"));

    const [first, second] = sectionItems(NOTES_TITLE);
    expect(sectionItems(NOTES_TITLE)).toHaveLength(2);
    expect(first.textContent).toContain("E1 · Solution avant diagnostic");
    expect(first.textContent).toContain("Bloquant");
    expect(first.textContent).toContain("tour 1");
    expectReadableGray([...first.querySelectorAll("span")].find((s) => s.textContent === "tour 1"));
    expect(first.textContent).toContain("« un data lake groupe »");
    expect(first.textContent).toContain(notes[0].note);
    expect(first.className).toContain("border-l-rose-500");
    // The debrief flags E1 too (the demo's recorded challenge), not E2.
    expect(debrief.flags.some((f) => f.reflex === "E1")).toBe(true);
    expect(first.textContent).toContain("aussi relevé par le débrief");
    expect(second.textContent).toContain("E2 · Technologie présentée comme objectif");
    expect(second.textContent).toContain("Important");
    expect(second.textContent).toContain("tour 2");
    expect(second.textContent).toContain("« migrer vers le cloud »");
    expect(second.className).toContain("border-l-amber-400");
    expect(second.textContent).not.toContain("aussi relevé par le débrief");

    const score = interviewScore(useSession.getState())!;
    const { interview } = useSession.getState();
    expect(interviewScore({ ...useSession.getState(), interview: { ...interview!, observations: [] } })).toEqual(score);
    expect(region).toContain(`${score.score}/ 100`);
  });

  it("has no notes section when the client noted nothing, or for an interview saved before the notes", () => {
    useSession.setState(sessionAt({ status: "done", messages: goodbye, debrief, observations: [] }), true);
    render(createElement(InterviewView));
    expect(container!.querySelector('[role="region"]')?.textContent).toContain("Débrief de l'entretien");
    expect(text()).not.toContain(NOTES_TITLE);

    const older = sessionAt({ status: "done", messages: goodbye, debrief });
    expect(older.interview).not.toHaveProperty("observations");
    act(() => useSession.setState(older, true));
    expect(container!.querySelector('[role="region"]')?.textContent).toContain("Points forts");
    expect(text()).not.toContain(NOTES_TITLE);
  });

  it("keeps the notes hidden until the debrief is there", () => {
    useSession.setState(sessionAt({ messages: goodbye, observations: notes }), true);
    render(createElement(InterviewView));
    expect(text()).not.toContain(NOTES_TITLE);
    act(() => useSession.setState((s) => ({ interview: { ...s.interview!, status: "debriefing" } })));
    expect(text()).toContain("Débrief en cours");
    expect(text()).not.toContain(notes[0].note);
    act(() => useSession.setState((s) => ({ interview: { ...s.interview!, status: "done", debrief } })));
    expect(text()).toContain(notes[0].note);
  });

  it("shows them in the read-only recap, with or without a debrief", () => {
    useSession.setState(
      sessionAt({ status: "done", messages: goodbye, revealed: ["Q2"], debrief, observations: notes, closed: true }),
      true,
    );
    render(createElement(InterviewRecap));
    expect(text()).not.toContain(NOTES_TITLE);
    click("Ton entretien client");
    expect(container!.querySelector('[role="region"]')?.textContent).toContain(NOTES_TITLE);
    expect(sectionItems(NOTES_TITLE)[0].textContent).toContain("aussi relevé par le débrief");
    expect(document.activeElement).toBe(document.body);

    // Left before its debrief: the notes were recorded live, there is just nothing to compare them with.
    act(() =>
      useSession.setState(
        sessionAt({ status: "error", messages: asked, error: "Entretien quitté avant la fin.", observations: notes, closed: true }),
        true,
      ),
    );
    expect(text()).toContain("Pas de débrief pour cet entretien.");
    expect(text()).toContain(NOTES_TITLE);
    expect(sectionItems(NOTES_TITLE)).toHaveLength(2);
    expect(text()).not.toContain("aussi relevé par le débrief");
  });
});
