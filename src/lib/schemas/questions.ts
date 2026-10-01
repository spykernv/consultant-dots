import { z } from "zod";
import { listOf } from "./common";

export const ClarificationQuestionSchema = z.object({
  id: z.string().describe("Q1, Q2, …"),
  question: z.string().describe("Concise, the way a consultant would ask the client"),
  whyItMatters: z.string().describe("One line"),
  decisionImpact: z
    .string()
    .describe("The decision that flips depending on the answer, e.g. 'centralisé vs fédéré'"),
  defaultAssumption: z
    .string()
    .describe("The explicit working assumption used if the client cannot answer"),
});

export const QuestionSetSchema = z.object({
  questions: listOf(
    ClarificationQuestionSchema,
    "3-5 questions, highest information value first",
  ),
});

export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
export type QuestionSet = z.infer<typeof QuestionSetSchema>;
