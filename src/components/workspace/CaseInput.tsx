"use client";

import { useState } from "react";
import { ArrowRight, FlaskConical, Sparkles } from "lucide-react";
import { MAX_CASE_CHARS } from "@/lib/schemas/api";
import { SAMPLE_CASES } from "@/lib/samples";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { SavedCases } from "./SavedCases";
import { ConfidentialityNotice, HealthBadge, Timer } from "./TopBar";

export function CaseInput() {
  const caseText = useSession((s) => s.caseText);
  const caseId = useSession((s) => s.caseId);
  const [startTimer, setStartTimer] = useState(true);
  const tooShort = caseText.trim().length < 20;

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <span className="text-sm font-semibold text-slate-900">Consultant Dots</span>
        <span className="text-xs text-slate-400">Préparation de business case · conseil en technologie</span>
        <div className="ml-auto flex items-center gap-2">
          <Timer compact />
          <HealthBadge />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Colle le business case</h1>
          <p className="mt-1 text-sm text-slate-500">
            Le copilote identifie le type de problème, sépare faits et hypothèses, puis te propose les questions à poser
            avant de construire le diagnostic, les options, la cible, la roadmap et ta restitution orale.
          </p>
        </div>

        <ConfidentialityNotice className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2" />

        <Textarea
          value={caseText}
          onChange={(e) => actions.setCaseText(e.target.value)}
          placeholder="Énoncé du case (contexte, entreprise, problème, contraintes…)"
          maxLength={MAX_CASE_CHARS}
          className="min-h-64 bg-white text-sm leading-relaxed"
          autoFocus
        />
        <div className="-mt-2 text-right text-[11px] text-slate-400">
          {caseText.length.toLocaleString("fr-FR")} / {MAX_CASE_CHARS.toLocaleString("fr-FR")} caractères
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Cases d&apos;entraînement :</span>
          {SAMPLE_CASES.map((sample) => (
            <Button
              key={sample.id}
              size="sm"
              variant={caseId === sample.id ? "secondary" : "outline"}
              onClick={() => actions.loadCase(sample.text, sample.id)}
            >
              <span className="text-slate-400">{sample.domain}</span> {sample.title}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-slate-200 pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <Checkbox checked={startTimer} onCheckedChange={(v) => setStartTimer(v === true)} />
            Lancer le chrono 10 min
          </label>
          <Button
            variant="link"
            className="px-0 text-slate-500"
            onClick={() => {
              const sample = SAMPLE_CASES[0];
              actions.loadCase(sample.text, sample.id);
              actions.analyse({ mock: true, startTimer: false });
            }}
          >
            <FlaskConical /> Démo sans IA
          </Button>
          <Button
            size="lg"
            className="ml-auto bg-indigo-700 px-4 hover:bg-indigo-800"
            disabled={tooShort}
            onClick={() => actions.analyse({ mock: false, startTimer })}
          >
            <Sparkles /> Analyser le case <ArrowRight />
          </Button>
        </div>

        <SavedCases />
      </main>
    </div>
  );
}
