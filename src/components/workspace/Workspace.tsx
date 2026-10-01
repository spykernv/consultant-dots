"use client";

import { useEffect, useState } from "react";
import { startAutosave } from "@/lib/store/autosave";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { CaseInput } from "./CaseInput";
import { CasePanel } from "./CasePanel";
import { DiagramsPanel } from "./DiagramsPanel";
import { OralPanel } from "./OralPanel";
import { QuestionsBlock } from "./QuestionsPanel";
import { ReasoningBlock } from "./ReasoningPanel";
import { RoadmapPanel } from "./RoadmapPanel";
import { StageStatus } from "./StageStatus";
import { StaleBanner } from "./StaleBanner";
import { TopBar } from "./TopBar";
import { Zone } from "./Zone";

function CenterZone() {
  const gatePassed = useSession((s) => s.gatePassed);
  return (
    <Zone
      title="Raisonnement"
      notesKey="reasoning"
      status={<StageStatus stages={gatePassed ? ["diagnose", "options"] : ["questions"]} />}
    >
      <QuestionsBlock />
      {gatePassed && <ReasoningBlock />}
    </Zone>
  );
}

export default function Workspace() {
  const [hydrated, setHydrated] = useState(false);
  const started = useSession((s) => s.started);
  const gatePassed = useSession((s) => s.gatePassed);

  useEffect(() => {
    void Promise.resolve(useSession.persist.rehydrate()).finally(() => setHydrated(true));
  }, []);

  // Only after rehydration: saving the empty initial state could never overwrite a case, but it would be noise.
  useEffect(() => (hydrated ? startAutosave() : undefined), [hydrated]);

  if (!hydrated) return <div className="min-h-dvh bg-slate-50" />;
  if (!started) return <CaseInput />;

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 lg:h-dvh">
      <TopBar />
      <StaleBanner />
      <main
        className={cn(
          "grid flex-1 grid-cols-1 gap-3 p-3 lg:min-h-0 lg:grid-cols-[minmax(260px,24fr)_minmax(360px,40fr)_minmax(340px,36fr)]",
          // Until the gate, the questions need the room; the empty roadmap/oral row stays a thin strip.
          gatePassed ? "lg:grid-rows-[minmax(0,58fr)_minmax(0,42fr)]" : "lg:grid-rows-[minmax(0,1fr)_8rem]",
        )}
      >
        <CasePanel className="max-lg:max-h-[80dvh]" />
        <CenterZone />
        <DiagramsPanel className="max-lg:min-h-96" />
        <div className="grid gap-3 lg:col-span-3 lg:min-h-0 lg:grid-cols-[58fr_42fr]">
          <RoadmapPanel />
          <OralPanel />
        </div>
      </main>
    </div>
  );
}
