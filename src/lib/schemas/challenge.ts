import { z } from "zod";
import { listOf, ReflexIdSchema } from "./common";

export const CHALLENGE_LEVELS = ["a_retravailler", "correct", "solide", "impressionnant"] as const;
export type ChallengeLevel = (typeof CHALLENGE_LEVELS)[number];

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ChallengeSchema = z.object({
  level: z
    .enum(CHALLENGE_LEVELS)
    .describe("Overall level of the answer, calibrated for a junior consultant interview"),
  verdict: z.string().describe("One or two sentences of overall assessment, as the interviewer would say it"),
  flags: listOf(
    z.object({
      reflex: ReflexIdSchema,
      severity: z.enum(SEVERITIES),
      quote: z
        .string()
        .describe(
          "Verbatim excerpt of the candidate's answer (max 20 words) that shows the issue, copied exactly; empty string when the issue is an omission",
        ),
      issue: z.string().describe("What is wrong, one line"),
      interviewerQuestion: z.string().describe("How the interviewer would push back, one sentence"),
      fix: z.string().describe("What a strong candidate would say instead, one or two sentences"),
    }),
    "0-6 flags for real issues only, most severe first",
  ),
  strengths: listOf(z.string(), "1-3 genuine strengths of the answer"),
  missing: listOf(z.string(), "0-4 important elements missing from the answer"),
  nextVersion: listOf(z.string(), "2-4 concrete improvements for the next version, most impactful first"),
});

export type Challenge = z.infer<typeof ChallengeSchema>;
