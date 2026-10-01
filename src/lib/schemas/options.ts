import { z } from "zod";
import { listOf, ReflexIdSchema, ScoreSchema } from "./common";

export const VERDICTS = ["pilot", "next", "later", "avoid"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

export const FITS = ["pass", "partial", "fail"] as const;
export const FitSchema = z.enum(FITS);
export type Fit = z.infer<typeof FitSchema>;

export const InitiativeSchema = z.object({
  name: z.string().describe("2-6 words"),
  value: ScoreSchema.describe("Business value, 5 = highest"),
  feasibility: ScoreSchema.describe("5 = easiest"),
  risk: ScoreSchema.describe("5 = highest risk"),
  timeToValue: ScoreSchema.describe("5 = fastest value"),
  reuse: ScoreSchema.describe("Reusable foundations / strategic fit, 5 = highest"),
  verdict: VerdictSchema,
  comment: z.string().describe("One line"),
});
export type Initiative = z.infer<typeof InitiativeSchema>;

export const OptionComparisonSchema = z.object({
  constraints: listOf(
    z.object({
      label: z.string().describe("The constraint, 3-8 words, e.g. 'Données RH et clients restent en Allemagne'"),
      basis: listOf(z.string(), "Ids (F#, Q#, C#, A#) this constraint comes from"),
      fits: listOf(
        z.object({
          optionId: z.string(),
          fit: FitSchema.describe(
            "pass = met as designed; partial = met only with a workaround or a condition; fail = the option breaks it",
          ),
          note: z.string().describe("Why, max 10 words"),
        }),
        "Exactly one per option, in the order of the options",
      ),
    }),
    "1-3 hard constraints of the case that discriminate between the options (go / no-go). Skip constraints every option meets",
  ),
  criteria: listOf(
    z.object({
      label: z
        .string()
        .describe("A decision criterion phrased so that 5 is best, 2-5 words, e.g. 'Rapidité de mise en valeur', 'Maîtrise du risque'"),
      scores: listOf(
        z.object({ optionId: z.string(), score: ScoreSchema.describe("5 = best for the client on this criterion") }),
        "Exactly one per option, in the order of the options",
      ),
    }),
    "3-4 decision criteria that matter most for this client",
  ),
});
export type OptionComparison = z.infer<typeof OptionComparisonSchema>;

export const EMPTY_COMPARISON: OptionComparison = { constraints: [], criteria: [] };

export const PivotSchema = z.object({
  basis: z
    .string()
    .describe("Id of the uncertain point: an assumption (A#) or a question answered only by a working assumption (Q#)"),
  question: z.string().describe("The uncertain point as a short question, max 8 words, e.g. 'Données RH dans le périmètre ?'"),
  assumed: z.string().describe("What we assume today, max 6 words"),
  ifInstead: z.string().describe("The other answer that would change the decision, max 6 words"),
  thenOptionId: z
    .string()
    .nullable()
    .describe("Id of the option you would then recommend; null if the recommendation holds but must be adapted"),
  consequence: z.string().describe("What changes in that case, one line"),
});
export type Pivot = z.infer<typeof PivotSchema>;

// Sessions and demo fixtures recorded before the comparison and the pivots existed parse with empty defaults.
export const OptionsAnalysisSchema = z.object({
  options: listOf(
    z.object({
      id: z.string().describe("O1, O2, …"),
      name: z.string().describe("2-6 words"),
      description: z.string().describe("One line"),
      advantages: listOf(z.string(), "2-3 advantages"),
      drawbacks: listOf(z.string(), "2-3 drawbacks"),
      conditions: listOf(z.string(), "1-2 conditions under which this option is the right one"),
    }),
    "2-3 genuinely different structuring options, from the playbook's option typology",
  ),
  comparison: OptionComparisonSchema.default(EMPTY_COMPARISON).describe(
    "The options side by side, before recommending: hard constraints (go / no-go), then scored decision criteria",
  ),
  recommendation: z.object({
    optionId: z.string().nullable().describe("Id of the recommended option, or null if undecidable"),
    statement: z.string().describe("The recommendation in one sentence"),
    rationale: z.string().describe("Why, in 1-2 sentences, including the trade-off"),
    dependsOn: listOf(
      z.string(),
      "Ids of the assumptions (A#) or working assumptions (Q#) the recommendation rests on",
    ),
    pivots: listOf(
      PivotSchema,
      "1-3 uncertain points whose other answer would change the recommendation, most decisive first. Only genuine pivots",
    ).default([]),
  }),
  targetBlocks: listOf(
    z.object({
      id: z.string().describe("B1, B2, …"),
      name: z.string().describe("2-5 words"),
      role: z.string().describe("One line"),
    }),
    "3-6 building blocks of the recommended target, technical and organizational",
  ),
  initiatives: listOf(
    InitiativeSchema,
    "3-6 candidate initiatives, use cases or application groups to prioritize; exactly one with verdict 'pilot'",
  ),
  traps: listOf(
    z.object({ reflex: ReflexIdSchema, whyHere: z.string().describe("Why it applies to this case, one line") }),
    "The 2-3 consulting reflexes (E1-E10) most relevant to this case",
  ),
});

export type OptionsAnalysis = z.infer<typeof OptionsAnalysisSchema>;
