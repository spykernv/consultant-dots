import { z } from "zod";
import { BackboneStageSchema, listOf } from "./common";

export const DiagnosticSchema = z.object({
  framework: listOf(
    z.object({
      step: z.string().describe("Case-specific step name, 2-5 words"),
      backbone: BackboneStageSchema.describe("Which stage of the universal backbone this step belongs to"),
      focus: z.string().describe("What we look at in this case, one line"),
      keyQuestions: listOf(z.string(), "1-3 key questions for this step"),
    }),
    "5-7 steps: the universal backbone adapted to this case, in the order of the playbook's sequence",
  ),
  findings: listOf(
    z.object({
      dimension: z.string().describe("A dimension of the playbook's analysis grid"),
      finding: z.string().describe("What we can say about it, one line"),
      basis: listOf(
        z.string(),
        "Ids this finding rests on: facts (F#), client answers or working assumptions (Q#), client notes (C#), assumptions (A#). Empty only for pure inference",
      ),
    }),
    "4-8 findings applying the playbook's analysis grid",
  ),
  rootCauses: listOf(z.string(), "2-4 root causes behind the pain points (organizational causes count)"),
  keyInsight: z.string().describe("The one-sentence 'so what' of the diagnostic"),
});

export type Diagnostic = z.infer<typeof DiagnosticSchema>;
