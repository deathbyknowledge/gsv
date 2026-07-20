import { describe, expect, it } from "vitest";
import {
  AGENT_IMAGE_POOL,
  avatarConfigKey,
  avatarForAccount,
  pickAgentImage,
  usedAgentImages,
} from "./agentPresentation";
import type { ConsoleAccount, ConsoleConfigEntry } from "./consoleModels";

function account(overrides: Partial<ConsoleAccount>): ConsoleAccount {
  return {
    uid: 1000,
    username: "agent",
    displayName: "AGENT",
    relation: "agent",
    runnable: true,
    gecos: "",
    capabilities: [],
    ...overrides,
  } as ConsoleAccount;
}

function configEntry(key: string, value: string): ConsoleConfigEntry {
  return { key, value, redacted: false };
}

describe("pickAgentImage", () => {
  it("returns a pool image when nothing is used", () => {
    expect(AGENT_IMAGE_POOL).toContain(pickAgentImage([], () => 0.99));
    expect(pickAgentImage([], () => 0)).toBe(AGENT_IMAGE_POOL[0]);
  });

  it("only picks unused images while the pool has spares", () => {
    const used = [AGENT_IMAGE_POOL[0], AGENT_IMAGE_POOL[2], AGENT_IMAGE_POOL[4]];
    const remaining = [AGENT_IMAGE_POOL[1], AGENT_IMAGE_POOL[3]];
    expect(pickAgentImage(used, () => 0)).toBe(remaining[0]);
    expect(pickAgentImage(used, () => 0.99)).toBe(remaining[1]);
  });

  it("repeats from the full pool once every image is used", () => {
    expect(pickAgentImage([...AGENT_IMAGE_POOL], () => 0)).toBe(AGENT_IMAGE_POOL[0]);
    expect(pickAgentImage([...AGENT_IMAGE_POOL], () => 0.99)).toBe(AGENT_IMAGE_POOL[4]);
  });

  it("ignores malformed used values", () => {
    const junk = ["", "/img/unknown.png", "agent-1.png"];
    // Junk doesn't shrink the candidate pool.
    expect(pickAgentImage(junk, () => 0)).toBe(AGENT_IMAGE_POOL[0]);
  });
});

describe("avatarForAccount", () => {
  const agentA = account({ uid: 2000, username: "aria" });
  const agentB = account({ uid: 2001, username: "orso" });
  const human = account({ uid: 1000, username: "jess", relation: "self" });
  const accounts = [human, agentA, agentB];

  it("returns the orb for humans regardless of config", () => {
    const config = [configEntry(avatarConfigKey(1000), AGENT_IMAGE_POOL[3])];
    expect(avatarForAccount(human, config, accounts)).toBe("/img/orb.png");
  });

  it("returns the persisted portrait when set", () => {
    const config = [configEntry(avatarConfigKey(2001), AGENT_IMAGE_POOL[4])];
    expect(avatarForAccount(agentB, config, accounts)).toBe(AGENT_IMAGE_POOL[4]);
  });

  it("ignores persisted values outside the pool", () => {
    const config = [configEntry(avatarConfigKey(2000), "/img/evil.png")];
    // Falls back to the legacy position-derived portrait.
    expect(avatarForAccount(agentA, config, accounts)).toBe("/img/agent-0.png");
  });

  it("falls back to the legacy agent-index portrait (mod 3) when unset", () => {
    // agents sort personal-agent/agent first; among agents A then B by username
    expect(avatarForAccount(agentA, [], accounts)).toBe("/img/agent-0.png");
    expect(avatarForAccount(agentB, [], accounts)).toBe("/img/agent-1.png");
  });
});

describe("usedAgentImages", () => {
  it("collects resolved portraits for agents only", () => {
    const agentA = account({ uid: 2000, username: "aria" });
    const agentB = account({ uid: 2001, username: "orso" });
    const human = account({ uid: 1000, username: "jess", relation: "self" });
    const config = [configEntry(avatarConfigKey(2001), AGENT_IMAGE_POOL[4])];
    const used = usedAgentImages([human, agentA, agentB], config);
    expect(used).toEqual(["/img/agent-0.png", AGENT_IMAGE_POOL[4]]);
  });
});
