import { describe, expect, it } from "vitest";
import type { ConsoleAccount, ConsolePackage } from "../domain/consoleModels";
import { isEligibleApplicationReviewer, packageCapabilitySummary } from "./packageImportFlow";

function account(patch: Partial<ConsoleAccount>): ConsoleAccount {
  return {
    uid: 1001,
    username: "agent",
    displayName: "Agent",
    relation: "personal-agent",
    runnable: true,
    gecos: "",
    ...patch,
  };
}

function pkg(patch: Partial<ConsolePackage>): ConsolePackage {
  return {
    packageId: "import:team/strudel-live:.",
    name: "strudel-live",
    description: "",
    version: "",
    runtime: "dynamic-worker",
    enabled: false,
    scopeKind: "user",
    scopeUid: 1000,
    sourceRepo: "team/strudel-live",
    sourceRef: "main",
    sourceSubdir: ".",
    sourcePublic: true,
    reviewRequired: true,
    reviewApprovedAt: null,
    reviewPending: true,
    installedAt: null,
    updatedAt: null,
    bindingNames: [],
    entrypoints: [],
    uiEntrypoints: [],
    profiles: [],
    ...patch,
  };
}

describe("package import flow", () => {
  it("limits application reviewer choices to runnable agent accounts", () => {
    expect(isEligibleApplicationReviewer(account({ relation: "self", username: "owner" }))).toBe(false);
    expect(isEligibleApplicationReviewer(account({ relation: "human", username: "shared-human" }))).toBe(false);
    expect(isEligibleApplicationReviewer(account({ relation: "personal-agent", username: "agent" }))).toBe(true);
    expect(isEligibleApplicationReviewer(account({ relation: "agent", username: "reviewer" }))).toBe(true);
    expect(isEligibleApplicationReviewer(account({ relation: "agent", runnable: false }))).toBe(false);
  });

  it("includes service profiles in package capability summaries", () => {
    expect(packageCapabilitySummary(pkg({
      profiles: [{
        name: "coproducer",
        displayName: "Co-producer",
        description: "",
        icon: "",
        capabilities: [],
        account: {
          runAs: "strudel-live#coproducer",
          username: "strudel-live-coproducer",
          provisioned: false,
          runnable: false,
        },
      }],
    }))).toContain("1 service profile");
  });
});
