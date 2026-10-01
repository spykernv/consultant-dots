"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { StageId } from "@/lib/schemas";
import { initialSession, markInterrupted, migrateSession, SESSION_VERSION, type Session } from "./machine";

export const useSession = create<Session>()(
  persist(() => initialSession(), {
    name: "consultant-dots",
    version: SESSION_VERSION,
    storage: createJSONStorage(() => sessionStorage),
    skipHydration: true,
    merge: (persisted, current) => markInterrupted({ ...current, ...(persisted as Partial<Session>) }),
    migrate: (persisted, version) => migrateSession(persisted, version),
  }),
);

export type LivePhase = "starting" | "thinking" | "writing";

/** Streaming state: never persisted, rewritten on every delta. */
export type LiveState = {
  partial: Partial<Record<StageId, unknown>>;
  phase: Partial<Record<StageId, LivePhase>>;
  startedAt: Partial<Record<StageId, number>>;
};

export const useLive = create<LiveState>()(() => ({ partial: {}, phase: {}, startedAt: {} }));
