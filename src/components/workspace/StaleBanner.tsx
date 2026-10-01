"use client";

import { RefreshCw } from "lucide-react";
import type { StageId } from "@/lib/schemas";
import { STAGE_LABELS } from "@/lib/domain/labels";
import { staleStages } from "@/lib/store/machine";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { Button } from "@/components/ui/button";

/** One place to catch up after an edited clarification, a regenerated section or a new pilot. */
export function StaleBanner() {
  const stale = useSession((s) => staleStages(s).join(","));
  const running = useSession((s) => Object.values(s.stages).some((r) => r.status === "running"));
  if (!stale || running) return null;
  const labels = stale.split(",").map((stage) => STAGE_LABELS[stage as StageId]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
      <RefreshCw className="size-3.5 shrink-0" />
      <span>
        <strong>{labels.join(", ")}</strong> {labels.length > 1 ? "ne sont plus à jour" : "n'est plus à jour"} (clarification
        modifiée, section régénérée ou pilote changé).
      </span>
      <Button size="xs" variant="outline" className="border-amber-300 bg-white" onClick={() => actions.refreshStale()}>
        Mettre à jour la suite
      </Button>
    </div>
  );
}
