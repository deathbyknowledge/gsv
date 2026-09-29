import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/TextInput";
import { collectNodes, createTestRoot } from "../../testing/testHarness";
import { HumanInvitationScreen } from "./HumanInvitationScreen";

const { redeem } = vi.hoisted(() => ({ redeem: vi.fn(async () => ({ uid: 1000, username: "member" })) }));

vi.mock("../../services/session/SessionProvider", () => ({
  useSession: () => ({ service: { client: {} }, snapshot: { url: "wss://space.example.com/ws" } }),
}));
vi.mock("../../services/session/accountRecovery", () => ({
  readHumanInvitationAttempt: () => ({ id: "invitation", secret: "secret", proof: "proof" }),
  redeemHumanInvitation: redeem,
}));

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("human invitation legal notice", () => {
  it("shows both policies and requires acknowledgment before joining a space", async () => {
    redeem.mockClear();
    const root = createTestRoot("Human invitation");
    let tree: ComponentChildren = null;
    function Harness() {
      tree = HumanInvitationScreen();
      return null;
    }
    const nodes = () => collectNodes(tree);
    const join = () => nodes().find((node) => node.type === Button)!;
    const form = () => nodes().find((node) => node.type === "form")!;
    try {
      await root.render(<Harness />);
      expect(nodes().filter((node) => node.type === "a").map((node) => node.props.href)).toEqual([
        "https://gsv.space/terms/",
        "https://humansandmachin.es/privacy/",
      ]);
      expect(join().props.disabled).toBe(true);
      await act(() => { nodes().find((node) => node.type === TextInput)!.props.onChange?.("member-password"); });
      expect(join().props.disabled).toBe(true);
      await act(() => {
        (form().props as unknown as { onSubmit: (event: { preventDefault: () => void }) => void }).onSubmit({ preventDefault: () => undefined });
      });
      expect(redeem).not.toHaveBeenCalled();
      await act(() => {
        (nodes().find((node) => (node.props as { id?: string }).id === "join-legal-acknowledgment")!.props as unknown as {
          onChange: (event: { currentTarget: { checked: boolean } }) => void;
        }).onChange({ currentTarget: { checked: true } });
      });
      expect(join().props.disabled).toBe(false);
    } finally { await root.unmount(); }
  });
});
