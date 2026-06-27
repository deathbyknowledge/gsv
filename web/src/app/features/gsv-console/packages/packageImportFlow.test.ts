import { describe, expect, it } from "vitest";
import type { ConsoleAccount } from "../domain/consoleModels";
import { isEligibleApplicationReviewer } from "./packageImportFlow";

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

describe("package import flow", () => {
  it("limits application reviewer choices to runnable agent accounts", () => {
    expect(isEligibleApplicationReviewer(account({ relation: "self", username: "owner" }))).toBe(false);
    expect(isEligibleApplicationReviewer(account({ relation: "human", username: "shared-human" }))).toBe(false);
    expect(isEligibleApplicationReviewer(account({ relation: "personal-agent", username: "agent" }))).toBe(true);
    expect(isEligibleApplicationReviewer(account({ relation: "agent", username: "reviewer" }))).toBe(true);
    expect(isEligibleApplicationReviewer(account({ relation: "agent", runnable: false }))).toBe(false);
  });
});
