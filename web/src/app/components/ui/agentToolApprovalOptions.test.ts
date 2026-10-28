import { describe, expect, it } from "vitest";
import { capabilityLabelKey, humanToolCapabilityLabel, isCustomMatch, matchOptionsForRule } from "./agentToolApprovalOptions";

/** The default `users` group (gid 100) in workers/gateway/src/kernel/capabilities.ts; keep the two in step. */
const DEFAULT_USER_CAPABILITIES = [
  "codemode.*", "fs.*", "shell.*", "net.fetch", "web.search",
  "mail.send", "mail.status", "mail.list", "mail.search", "mail.read",
  "conversation.*", "contact.*", "profile.*", "approach.*", "atproto.*", "proc.*", "signal.*",
  "repo.apply", "repo.compare", "repo.create", "repo.delete", "repo.diff", "repo.import", "repo.list",
  "repo.log", "repo.read", "repo.refs", "repo.search", "repo.visibility.set",
  "sched.*", "r12y.*",
  "ai.models", "ai.text.generate", "ai.image.generate", "ai.image.read", "ai.transcription.create", "ai.speech.create",
  "adapter.connect", "adapter.disconnect", "adapter.list", "adapter.pair.*", "adapter.route", "adapter.send", "adapter.status",
  "sys.config.get", "sys.config.set", "sys.bootstrap", "sys.feedback", "sys.instance.*", "sys.browser.*",
  "sys.target.get", "sys.target.list", "sys.target.update", "sys.target.delete", "sys.ledger.list",
  "sys.oauth.device.poll", "sys.oauth.device.start", "sys.oauth.forget", "sys.oauth.list", "sys.oauth.start",
  "sys.mcp.add", "sys.mcp.call", "sys.mcp.list", "sys.mcp.refresh", "sys.mcp.remove",
  "sys.link.list", "sys.token.create", "sys.token.list", "sys.token.revoke",
  "sys.pair.create", "sys.pair.list", "sys.pair.cancel",
  "account.create", "account.list",
];

describe("agent tool approval options", () => {
  it("offers an explicit outbound mail approval override", () => {
    expect(matchOptionsForRule("")).toContainEqual({ value: "mail.send", label: "Send mail" });
  });

  it("names every capability a normal account holds in plain words", () => {
    expect(DEFAULT_USER_CAPABILITIES).toHaveLength(74);
    expect(DEFAULT_USER_CAPABILITIES.filter((capability) => !capabilityLabelKey(capability))).toEqual([]);
    expect(humanToolCapabilityLabel("ai.text.generate")).toBe("Write with AI");
    expect(humanToolCapabilityLabel("r12y.*")).toBe("Responsibilities");
    expect(humanToolCapabilityLabel("adapter.pair.*")).toBe("Connect a messenger");
    expect(humanToolCapabilityLabel("sys.oauth.start")).toBe("Sign in to services");
  });

  it("gives every capability a distinct name in the account list", () => {
    const labels = DEFAULT_USER_CAPABILITIES.map(humanToolCapabilityLabel);
    expect(labels.filter((label, index) => labels.indexOf(label) !== index)).toEqual([]);
  });

  it("names a single syscall by its longest labelled family", () => {
    expect(capabilityLabelKey("conversation.send")).toBe("approval.family.conversation");
    expect(capabilityLabelKey("sys.pair.redeem")).toBe("approval.family.sysPair");
    expect(capabilityLabelKey("adapter.pair.confirm")).toBe("approval.family.adapterPair");
    expect(capabilityLabelKey("adapter.inbound")).toBe("approval.family.adapter");
    expect(capabilityLabelKey("fs.transfer.send")).toBe("approval.family.fs");
    expect(humanToolCapabilityLabel("sched.add")).toBe("Routines");
    expect(humanToolCapabilityLabel("sys.oauth.*")).toBe("Service sign-ins");
  });

  it("prefers a capability's own label over its family", () => {
    expect(humanToolCapabilityLabel("fs.*")).toBe("All file tools");
    expect(humanToolCapabilityLabel("fs.read")).toBe("Read files");
    expect(humanToolCapabilityLabel("atproto.write")).toBe("Publish to the open network");
  });

  it("falls back to the id's words only for an unknown family", () => {
    expect(capabilityLabelKey("plugin.special_action")).toBeUndefined();
    expect(humanToolCapabilityLabel("plugin.special_action")).toBe("Plugin Special Action");
    expect(capabilityLabelKey("sys.unknown")).toBeUndefined();
  });

  it("keeps display-only labels out of the rule choices", () => {
    expect(matchOptionsForRule("")).toHaveLength(40);
    expect(isCustomMatch("ai.text.generate")).toBe(true);
    expect(matchOptionsForRule("ai.text.generate")).toHaveLength(41);
  });
});
