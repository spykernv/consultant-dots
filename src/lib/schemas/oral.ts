import { z } from "zod";
import { listOf } from "./common";

export const ORAL_SECTION_KINDS = [
  "reformulation",
  "structure",
  "analysis",
  "recommendation",
  "next_steps",
] as const;

export const OralRestitutionSchema = z.object({
  duration: z.string().describe("Estimated speaking time, e.g. '≈ 3 min'"),
  opening: z
    .string()
    .describe("One sentence announcing the structure, e.g. 'Je structurerais cette transformation en quatre étapes.'"),
  sections: listOf(
    z.object({
      kind: z.enum(ORAL_SECTION_KINDS),
      title: z.string().describe("2-4 words"),
      bullets: listOf(
        z.object({
          point: z.string().describe("The line to say, max 15 words"),
          detail: z.string().describe("1-3 spoken sentences to develop it if time allows"),
        }),
        "2-4 bullets",
      ),
    }),
    "Exactly 5 sections in this order: reformulation, structure, analysis, recommendation, next_steps",
  ),
  closing: z.string().describe("KPI and immediate next step, 1-2 sentences"),
  differentiators: listOf(
    z.object({
      point: z.string().describe("A senior-level touch that makes the difference, one line"),
      howToSayIt: z.string().describe("How to say it naturally, one sentence"),
    }),
    "2-3 points that make the difference",
  ),
});

export type OralRestitution = z.infer<typeof OralRestitutionSchema>;
