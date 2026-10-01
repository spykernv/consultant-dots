import { describe, expect, it } from "vitest";
import { DOMAIN_IDS } from "@/lib/schemas/common";
import { DOMAIN_TO_PLAYBOOK, PLAYBOOKS, renderPlaybook, selectPlaybooks } from "@/lib/playbooks";
import { PLAYBOOK_IDS } from "@/lib/playbooks/types";

describe("playbooks", () => {
  it("maps every domain to an existing playbook", () => {
    for (const domain of DOMAIN_IDS) expect(PLAYBOOKS[DOMAIN_TO_PLAYBOOK[domain]]).toBeDefined();
  });

  it("defines every playbook with the fields the prompts rely on", () => {
    for (const id of PLAYBOOK_IDS) {
      const p = PLAYBOOKS[id];
      expect(p.id).toBe(id);
      expect(p.sequence.length).toBeGreaterThan(2);
      expect(p.coreQuestions.length).toBeGreaterThan(2);
      expect(p.principles.length).toBeGreaterThan(0);
      expect(p.optionTypology.length).toBeGreaterThan(1);
    }
  });

  it("keeps the primary playbook out of the secondaries and caps them at two", () => {
    const { primary, secondary } = selectPlaybooks({
      primaryDomain: "cloud_transformation",
      secondaryDomains: ["si_transformation", "enterprise_architecture", "data_platform", "genai_ai"],
    });
    expect(primary.id).toBe("si_cloud");
    expect(secondary.map((p) => p.id)).toEqual(["enterprise_architecture", "data_platform"]);
  });

  it("renders the full primary playbook with its sequence and a condensed secondary", () => {
    expect(renderPlaybook(PLAYBOOKS.data_platform, "full")).toContain("Business use cases → Data diagnosis");
    const condensed = renderPlaybook(PLAYBOOKS.genai, "condensed");
    expect(condensed).toContain("Principles");
    expect(condensed).not.toContain("Core questions");
  });
});
