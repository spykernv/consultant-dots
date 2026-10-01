"use client";

import { useEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { interviewActions } from "@/lib/interview/client";
import { MAX_CANDIDATE_CHARS, type InterviewStatus } from "@/lib/interview/schema";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function Composer({ status, lastRound }: { status: InterviewStatus; lastRound: boolean }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  // The textarea is disabled while the client answers, which drops the focus: give it back after a send only,
  // so that a reload on a phone does not pop the keyboard up.
  const refocus = useRef(false);
  const ready = status === "ready";
  const canSend = ready && text.trim().length > 0;
  const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

  useEffect(() => {
    if (!ready || !refocus.current) return;
    refocus.current = false;
    input.current?.focus();
  }, [ready]);

  const send = () => {
    if (!canSend) return;
    refocus.current = true;
    interviewActions.send(text.trim());
    setText("");
  };

  return (
    <div className="space-y-1.5">
      {lastRound && ready && (
        <p className="text-[11px] text-amber-700">Dernier tour : c&apos;est le moment de conclure par ta recommandation.</p>
      )}
      <Textarea
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          ready
            ? "Pose ta question au client, reformule, propose une piste…"
            : status === "waiting"
              ? "Le client répond…"
              : "Clique sur « Réessayer » pour reprendre l'entretien."
        }
        maxLength={MAX_CANDIDATE_CHARS}
        disabled={!ready}
        rows={3}
        aria-label="Ton message au client"
        className="max-h-48 min-h-20 bg-white text-sm leading-relaxed"
      />
      <div className="flex items-center gap-2">
        {/* A touch keyboard has no such shortcut. */}
        <span className="hidden text-[11px] text-slate-400 sm:inline">{shortcut} + Entrée pour envoyer</span>
        <span
          className={cn(
            "ml-auto text-[11px] tabular-nums",
            text.length > MAX_CANDIDATE_CHARS * 0.9 ? "text-amber-700" : "text-slate-400",
          )}
          title="Limite volontaire : un exercice de synthèse, comme face à un vrai client."
        >
          {text.length > MAX_CANDIDATE_CHARS * 0.9 ? "Synthétise · " : ""}
          {text.length.toLocaleString("fr-FR")} / {MAX_CANDIDATE_CHARS.toLocaleString("fr-FR")}
        </span>
        <Button size="sm" className="bg-indigo-700 hover:bg-indigo-800" disabled={!canSend} onClick={send}>
          <SendHorizontal /> Envoyer
        </Button>
      </div>
    </div>
  );
}
