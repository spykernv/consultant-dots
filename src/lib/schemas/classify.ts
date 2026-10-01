import { z } from "zod";
import { DomainSchema, listOf } from "./common";

export const ClassificationSchema = z.object({
  primaryDomain: DomainSchema.describe("The single domain that best describes the core problem"),
  secondaryDomains: listOf(DomainSchema, "0 to 2 secondary domains, never repeating the primary one"),
  confidence: z
    .number()
    .describe("Confidence from 0 to 100; lower it when the case mixes domains or stays vague"),
  rationale: z
    .string()
    .describe("Why, in 1-2 sentences: the core business problem, not the technology the client mentions"),
});

export type Classification = z.infer<typeof ClassificationSchema>;
