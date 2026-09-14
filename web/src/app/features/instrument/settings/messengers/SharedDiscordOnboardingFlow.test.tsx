import { act } from "preact/test-utils";
import { expect, it, vi } from "vitest";
import type { ConnectFlowDef } from "../../../../components/connect-flow/connectFlowTypes";
import { collectText, createTestRoot, flowStepNodes, nodeWithLabel } from "../../../../testing/testHarness";
import { SharedDiscordOnboardingFlow, type ManagedTelegramDependencies } from "./ManagedTelegramOnboardingFlow";

it("opens server installation and requires explicit confirmation of the Discord person and scope", async () => {
  vi.stubGlobal("document", {});
  let flow: ConnectFlowDef | undefined;
  let step = 0;
  const inspect = vi.fn<ReturnType<ManagedTelegramDependencies["useInspectConsoleAdapterPairing"]>["mutateAsync"]>().mockResolvedValue({
    adapter: "discord", accountId: "application:1000:guild:4001", actorId: "discord:user:2001", surfaceId: "82001", routeScope: "actor", expiresAt: Date.now() + 60_000, linked: true,
  });
  const confirm = vi.fn<ReturnType<ManagedTelegramDependencies["useConfirmConsoleAdapterPairing"]>["mutateAsync"]>().mockResolvedValue({
    paired: true, adapter: "discord", accountId: "application:1000:guild:4001", actorId: "discord:user:2001", surfaceId: "82001", uid: 1000,
  });
  const dependencies: ManagedTelegramDependencies = {
    ConnectFlowShell: (props) => { flow = props.flow; step = props.current; return null; },
    useUnsavedGuard: () => undefined,
    useConsoleAdapterPairingInfo: (adapter) => {
      expect(adapter).toBe("discord");
      return { data: { adapter, accountId: "application:1000", configured: true, installUrl: "https://discord.com/oauth2/authorize?client_id=1000" }, isError: false, error: null };
    },
    useInspectConsoleAdapterPairing: () => ({ mutateAsync: inspect, isPending: false }),
    useConfirmConsoleAdapterPairing: () => ({ mutateAsync: confirm, isPending: false }),
  };
  const root = createTestRoot("Discord pairing");
  const nodes = () => { if (!flow) throw new Error("Flow is not mounted"); return flowStepNodes(flow, step); };
  const click = async (label: string) => { await act(async () => { await nodeWithLabel(nodes(), label).props.onClick?.(); }); };
  try {
    await root.render(<SharedDiscordOnboardingFlow dependencies={dependencies} onBack={() => undefined} onConnected={() => undefined} />);
    expect(collectText(nodes().find((node) => node.props.href?.startsWith("https://discord.com/oauth2/authorize")))).toBe("INSTALL GSV IN DISCORD");
    expect(nodes().some((node) => node.props.label === "BOT TOKEN")).toBe(false);
    await click("I HAVE A CODE");
    await act(() => { nodeWithLabel(nodes(), "PAIRING CODE").props.onChange?.("abcd-efgh-jklm"); });
    await click("CHECK CODE");
    expect(inspect).toHaveBeenCalledWith({ adapter: "discord", code: "ABCD-EFGH-JKLM" });
    expect(confirm).not.toHaveBeenCalled();
    expect(nodeWithLabel(nodes(), "Discord user discord:user:2001").props.sub).toContain("application:1000:guild:4001");
    await click("YES, CONNECT THIS IDENTITY");
    expect(confirm).toHaveBeenCalledWith({ adapter: "discord", code: "ABCD-EFGH-JKLM" });
  } finally { await root.unmount(); vi.unstubAllGlobals(); }
});
