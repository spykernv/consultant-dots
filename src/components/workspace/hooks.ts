"use client";

import { useEffect, useMemo, useState } from "react";
import type { StageId, StageOutputs } from "@/lib/schemas";
import { buildCaseBrief, type CaseBrief } from "@/lib/prompts/brief";
import { useLive, useSession } from "@/lib/store/session-store";
import { isStale } from "@/lib/store/machine";

/** The same brief the post-gate prompts receive, rebuilt client-side for chips and tooltips. */
export function useBrief(): CaseBrief | null {
  const caseText = useSession((s) => s.caseText);
  const classification = useSession((s) => s.stages.classify.data);
  const mapping = useSession((s) => s.stages.frame.data);
  const questions = useSession((s) => s.stages.questions.data);
  const answers = useSession((s) => s.answers);
  const gatePassed = useSession((s) => s.gatePassed);
  const clientNotes = useSession((s) => s.clientNotes);

  return useMemo(() => {
    if (!classification || !mapping || !questions) return null;
    return buildCaseBrief({
      caseText,
      classification,
      mapping,
      questions,
      clarifications: questions.questions.map((q) => {
        const answer = (answers[q.id] ?? "").trim();
        return { questionId: q.id, answer, status: answer ? "answered" : gatePassed ? "assumed" : "open" };
      }),
      clientNotes,
    });
  }, [caseText, classification, mapping, questions, answers, gatePassed, clientNotes]);
}

export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export function useNow(intervalMs = 1000, active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

/** Final data when the stage is done, otherwise whatever has streamed in so far. */
export function useStageView<K extends StageId>(stage: K) {
  const run = useSession((s) => s.stages[stage]);
  const stale = useSession((s) => isStale(s, stage));
  const partial = useLive((l) => l.partial[stage]) as DeepPartial<StageOutputs[K]> | undefined;
  const phase = useLive((l) => l.phase[stage]);
  const startedAt = useLive((l) => l.startedAt[stage]);
  const streaming = run.status === "running";
  const data = (streaming && partial ? partial : run.data) as DeepPartial<StageOutputs[K]> | null;
  return { run, data, streaming, phase, startedAt, stale };
}

/** Width of an element, kept up to date; pass the setter as the element's `ref`. */
export function useElementWidth<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width] as const;
}

export function compact<T>(items: (T | null | undefined)[] | undefined): T[] {
  return (items ?? []).filter((x): x is T => x !== null && x !== undefined);
}
