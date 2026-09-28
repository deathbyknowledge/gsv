import { describe, expect, it, vi } from "vitest";
import { markApprovalSetup, saveAccountApprovalPolicy } from "./approvalPolicyService";
import { GSVClient } from "@humansandmachines/gsv/client";

describe("permission policy replacement", () => {
  const key = "users/1000/ai/tools/approval";
  const legacy = '{"default":"ask","rules":[],"future":true}';
  const replacement = '{"default":"ask","rules":[]}';

  it.each([replacement, ""])("replaces only the reviewed account policy, including returning to inheritance", async (value) => {
    const client = new GSVClient();
    vi.spyOn(client.sys.config, "get").mockResolvedValue({ entries: [{ key, value: legacy }] });
    const save = vi.spyOn(client.sys.config, "set").mockResolvedValue({ ok: true });
    await saveAccountApprovalPolicy(client, 1000, legacy, value);
    expect(client.sys.config.get).toHaveBeenCalledWith({ key });
    expect(save).toHaveBeenCalledExactlyOnceWith({ key, value });
  });

  it("does not overwrite a policy that changed while its draft was open", async () => {
    const client = new GSVClient();
    vi.spyOn(client.sys.config, "get").mockResolvedValue({ entries: [{ key, value: replacement }] });
    const save = vi.spyOn(client.sys.config, "set");
    await expect(saveAccountApprovalPolicy(client, 1000, legacy, "")).rejects.toThrow("changed elsewhere");
    expect(save).not.toHaveBeenCalled();
  });

  it("does not write over an inherited policy that changed since the draft was composed", async () => {
    const client = new GSVClient();
    const globalKey = "config/ai/tools/approval";
    vi.spyOn(client.sys.config, "get").mockImplementation(async (args) => ({
      entries: args?.key === globalKey ? [{ key: globalKey, value: '{"default":"deny","rules":[]}' }] : [],
    }));
    const save = vi.spyOn(client.sys.config, "set");
    await expect(saveAccountApprovalPolicy(client, 1000, "", replacement, { key: globalKey, value: "" })).rejects.toThrow("inherited policy changed");
    expect(save).not.toHaveBeenCalled();
    vi.spyOn(client.sys.config, "set").mockResolvedValue({ ok: true });
    await saveAccountApprovalPolicy(client, 1000, "", replacement, { key: globalKey, value: '{"default":"deny","rules":[]}' });
    expect(client.sys.config.set).toHaveBeenCalledWith({ key, value: replacement });
  });

  it("rejects unsupported replacement fields before issuing a syscall", async () => {
    const client = new GSVClient();
    const get = vi.spyOn(client.sys.config, "get");
    const save = vi.spyOn(client.sys.config, "set");
    await expect(saveAccountApprovalPolicy(client, 1000, "", legacy)).rejects.toThrow("not valid");
    expect(get).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("marks the walkthrough on the account's ui key and clears it with a blank", async () => {
    const client = new GSVClient();
    const save = vi.spyOn(client.sys.config, "set").mockResolvedValue({ ok: true });
    await markApprovalSetup(client, 1000, "skipped");
    await markApprovalSetup(client, 1000, "");
    expect(save.mock.calls).toEqual([[{ key: "users/1000/ui/approval-setup", value: "skipped" }], [{ key: "users/1000/ui/approval-setup", value: "" }]]);
  });
});
