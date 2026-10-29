import { describe, expect, it } from "vitest";
import { capabilityLabelKey, humanToolCapabilityLabel, isCustomMatch, matchOptionsForRule, ruleCapabilityLabel, targetOptionsForRule, targetOptionValue } from "./agentToolApprovalOptions";

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
    expect(matchOptionsForRule("")).toContainEqual({ value: "mail.send", label: "Send email" });
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
    expect(capabilityLabelKey("conversation.send")).toBe("approval.match.conversationSend");
    expect(capabilityLabelKey("contact.block")).toBe("approval.family.contact");
    expect(capabilityLabelKey("sys.pair.redeem")).toBe("approval.family.sysPair");
    expect(capabilityLabelKey("adapter.pair.confirm")).toBe("approval.match.adapterPairConfirm");
    expect(capabilityLabelKey("adapter.pair.redeem")).toBe("approval.family.adapterPair");
    expect(capabilityLabelKey("adapter.inbound")).toBe("approval.family.adapter");
    expect(capabilityLabelKey("fs.transfer.send")).toBe("approval.family.fs");
    expect(humanToolCapabilityLabel("sched.add")).toBe("Add a routine");
    expect(humanToolCapabilityLabel("sched.*")).toBe("Routines");
    expect(ruleCapabilityLabel("sched.add")).toBe("Add a routine");
    expect(ruleCapabilityLabel("sched.*")).toBe("Routines");
    expect(ruleCapabilityLabel("sched.remove")).toBe("Routines · sched.remove");
    expect(ruleCapabilityLabel("sys.instance.stop")).toBe("Cloud browsers and computers · sys.instance.stop");
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

describe("target options", () => {
  it("tells two connections of one name apart by id", () => {
    const options = targetOptionsForRule(undefined, [
      { id: "dev-1", label: "garage pi" },
      { id: "dev-2", label: "garage pi" },
      { id: "dev-3", label: "studio" },
    ]);
    expect(options.map((option) => option.label)).toEqual(expect.arrayContaining(["garage pi · dev-1", "garage pi · dev-2", "studio"]));
    expect(options.some((option) => option.label === "garage pi")).toBe(false);
  });

  it("tells a connection named like a built-in choice apart by id", () => {
    const shipHome = targetOptionsForRule(undefined, []).find((option) => option.value === targetOptionValue("gsv"))!.label;
    const options = targetOptionsForRule(undefined, [{ id: "dev-9", label: shipHome }]);
    expect(options.filter((option) => option.label === shipHome)).toHaveLength(1);
    expect(options.some((option) => option.label === `${shipHome} · dev-9`)).toBe(true);
  });

  it("marks a rule's forgotten machine so it never reads like a live connection of that name", () => {
    const options = targetOptionsForRule("macbook", [{ id: "dev-4", label: "macbook" }]);
    expect(options.find((option) => option.value === targetOptionValue("macbook"))?.label).toBe("macbook (not connected)");
    expect(options.find((option) => option.value === targetOptionValue("dev-4"))?.label).toBe("macbook");
  });

  it("reads a stored alias as what the runtime makes of it", () => {
    const builtin = targetOptionsForRule(undefined, []);
    const labelOf = (value: string) => builtin.find((option) => option.value === value)!.label;
    expect(targetOptionsForRule("any", []).find((option) => option.value === targetOptionValue("any"))?.label).toBe(labelOf(""));
    expect(targetOptionsForRule("gateway", []).find((option) => option.value === targetOptionValue("gateway"))?.label).toBe(labelOf(targetOptionValue("gsv")));
    expect(targetOptionsForRule("device", []).find((option) => option.value === targetOptionValue("device"))?.label)
      .toBe(targetOptionsForRule("targets/*", []).find((option) => option.value === targetOptionValue("targets/*"))!.label);
  });

  it("keeps labels unique even when a name equals another connection's derived label", () => {
    const options = targetOptionsForRule(undefined, [
      { id: "dev-1", label: "garage pi" },
      { id: "dev-2", label: "garage pi" },
      { id: "dev-7", label: "garage pi · dev-1" },
    ]);
    const labels = options.map((option) => option.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(options.find((option) => option.value === targetOptionValue("dev-7"))?.label).toBe("garage pi · dev-1 · dev-7");
  });
});
