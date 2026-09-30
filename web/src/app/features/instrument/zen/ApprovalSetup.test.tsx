import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { APPROVAL_CATEGORIES, type ApprovalCategoryId, type ApprovalPolicyAction } from "../../../domain/agentApproval";
import { ApprovalSetup, type ApprovalSetupProps } from "./ApprovalSetup";

const current = {
  shell: "ask", "machine-files": "ask", delete: "auto", web: "ask", tools: "ask", mail: "ask",
} satisfies Record<ApprovalCategoryId, ApprovalPolicyAction>;
const props: ApprovalSetupProps = {
  step: 1, choices: {}, current, editable: true, saving: false, error: null,
  onChoose: () => {}, onContinue: () => {}, onSkip: () => {},
};
const buttons = (tree: ReturnType<typeof ApprovalSetup>) => collectNodes(tree).filter((node) => node.type === "button");

describe("approval setup card", () => {
  it("opens with what runs on its own, then offers to go on or skip", () => {
    const tree = ApprovalSetup(props);
    const text = collectText(tree);
    expect(text).toContain("approval · setup");
    expect(text).toContain("In the ship I read and write files, run commands");
    expect(text).toContain("receipt under each answer");
    expect(text).toContain("go on");
    expect(text).toContain("skip and nothing changes");
    expect(text).not.toContain("Pick a side");
    for (const category of APPROVAL_CATEGORIES) expect(text).not.toContain(category.example);
  });

  it("lists every category with its example on step two, pressed to what the policy does today", () => {
    const tree = ApprovalSetup({ ...props, step: 2 });
    const text = collectText(tree);
    expect(text).toContain("Pick a side for each");
    for (const category of APPROVAL_CATEGORIES) {
      expect(text).toContain(category.label);
      expect(text).toContain(category.example);
    }
    const picks = buttons(tree).filter((node) => node.props["aria-pressed"] !== undefined);
    expect(picks).toHaveLength(APPROVAL_CATEGORIES.length * 2);
    const pressed = picks.filter((node) => node.props["aria-pressed"] === true).map((node) => collectText(node));
    expect(pressed).toEqual(["ask", "ask", "allow", "ask", "ask", "ask"]);
    expect(text).toContain("save it");
    expect(text).toContain("open settings, top right");
  });

  it("shows a denied row as blocked, with neither side pressed nor offered", () => {
    const tree = ApprovalSetup({ ...props, step: 2, current: { ...current, delete: "deny" } });
    expect(collectText(tree)).toContain("blocked");
    const picks = buttons(tree).filter((node) => node.props["aria-pressed"] !== undefined);
    const pressed = picks.filter((node) => node.props["aria-pressed"] === true).map((node) => collectText(node));
    expect(pressed).toEqual(["ask", "ask", "ask", "ask", "ask"]);
    const disabled = picks.filter((node) => node.props.disabled === true).map((node) => collectText(node));
    expect(disabled).toEqual(["allow", "ask"]);
  });

  it("shows an explicit pick over the current policy and reports it with the row id", () => {
    const onChoose = vi.fn();
    const tree = ApprovalSetup({ ...props, step: 2, choices: { shell: "auto" }, onChoose });
    const picks = buttons(tree).filter((node) => node.props["aria-pressed"] !== undefined);
    expect(collectText(picks[0])).toBe("allow");
    expect(picks[0].props["aria-pressed"]).toBe(true);
    picks[1].props.onClick?.();
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("shell", "ask");
  });

  it("explains without offering picks when the account cannot edit its policy", () => {
    const tree = ApprovalSetup({ ...props, editable: false });
    const text = collectText(tree);
    expect(text).toContain("Right now I ask before: running commands on your machines · changing files on your machines · fetching web pages through your machines · connected tools · sending email.");
    expect(text).toContain("needs an account that can edit settings");
    expect(text).toContain("got it");
    expect(text).not.toContain("skip");
    expect(buttons(tree)).toHaveLength(1);
  });

  it("holds the controls while saving and offers a retry after a failed save", () => {
    const saving = ApprovalSetup({ ...props, step: 2, saving: true });
    for (const node of buttons(saving)) expect(node.props.disabled).toBe(true);
    expect(collectText(saving)).toContain("saving…");
    const failed = ApprovalSetup({ ...props, step: 2, error: "offline" });
    expect(collectText(failed)).toContain("that didn't save: offline");
    expect(collectText(failed)).toContain("try again");
    for (const node of buttons(failed)) expect(node.props.disabled).toBe(false);
  });
});
