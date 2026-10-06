import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { APPROVAL_CATEGORIES, type ApprovalCategoryId, type ApprovalPolicyAction } from "../../../domain/agentApproval";
import { ApprovalSetup, type ApprovalSetupProps } from "./ApprovalSetup";

const current = {
  shell: "ask", "machine-files": "ask", delete: "auto", web: "ask", tools: "ask", mail: "ask",
} satisfies Record<ApprovalCategoryId, ApprovalPolicyAction>;
const props: ApprovalSetupProps = {
  stage: "ask", who: "hank", revealed: true, choices: {}, current, blocked: null, saving: false, error: null,
  onAllowAll: () => {}, onLimit: () => {}, onDetail: () => {}, onChoose: () => {}, onSave: () => {}, onWhy: () => {}, onClose: () => {},
};
const buttons = (tree: ReturnType<typeof ApprovalSetup>) => collectNodes(tree).filter((node) => node.type === "button");
const shipRows = (tree: ReturnType<typeof ApprovalSetup>) => collectNodes(tree).filter((node) => node.props.class === "zen-moment is-ship is-explain");
const yourRows = (tree: ReturnType<typeof ApprovalSetup>) => collectNodes(tree).filter((node) => node.props.class === "zen-moment is-human is-explain").map((node) => collectText(node));
const press = (tree: ReturnType<typeof ApprovalSetup>, label: string) => buttons(tree).find((node) => collectText(node) === label)?.props.onClick?.();

describe("approval explanation", () => {
  it("opens as a Ship message with the four choices", () => {
    const handlers = { onAllowAll: vi.fn(), onLimit: vi.fn(), onDetail: vi.fn(), onClose: vi.fn() };
    const tree = ApprovalSetup({ ...props, ...handlers });
    const text = collectText(tree);
    expect(shipRows(tree)).toHaveLength(1);
    expect(text).toContain("For most of what I do in the ship, I don't need to bother you. I only ask before sensitive tasks.");
    expect(text).toContain("Do you want me to stop asking?");
    expect(text).not.toContain("Right now I ask before");
    for (const category of APPROVAL_CATEGORIES) expect(text).not.toContain(category.example);
    press(tree, "Yes, turn on auto-approve for everything");
    press(tree, "Only ask before deleting something or contacting someone");
    press(tree, "What are sensitive tasks?");
    press(tree, "No, keep asking.");
    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledOnce();
  });

  it("lets the message land before its box, and the apology before the Ship's reason", () => {
    const reading = ApprovalSetup({ ...props, revealed: false });
    expect(collectText(reading)).toContain("I only ask before sensitive tasks.");
    expect(collectText(reading)).not.toContain("On your machines");
    expect(collectText(reading)).not.toContain("Do you want me to stop asking?");
    expect(buttons(reading)).toHaveLength(0);
    const listing = ApprovalSetup({ ...props, stage: "detail", revealed: false });
    expect(collectText(listing)).toContain("pick what I may do on my own");
    expect(buttons(listing)).toHaveLength(0);
    const why = ApprovalSetup({ ...props, stage: "why", blocked: "capability", revealed: false });
    expect(collectText(why)).not.toContain("permission to change settings");
    expect(buttons(why).map((node) => collectText(node))).toEqual(["got it"]);
  });

  it("answers what the sensitive tasks are, then lists every kind with a pick pressed to what the policy does today", () => {
    const tree = ApprovalSetup({ ...props, stage: "detail" });
    const text = collectText(tree);
    expect(shipRows(tree)).toHaveLength(2);
    expect(yourRows(tree)).toEqual(["hank What are sensitive tasks?"]);
    expect(text).toContain("Right now I ask before:");
    const list = collectNodes(tree).find((node) => node.type === "ul" && node.props["aria-label"] === undefined);
    const items = collectNodes(list).filter((node) => node.type === "li").map((node) => collectText(node));
    expect(items).toEqual(["running commands on your machines", "changing files on your machines", "fetching web pages through your machines", "connected tools", "sending email"]);
    expect(text).toContain("If you don't want to see some of these again, pick what I may do on my own.");
    for (const category of APPROVAL_CATEGORIES) {
      expect(text).toContain(category.label);
      expect(text).toContain(category.example);
    }
    const picks = buttons(tree).filter((node) => node.props["aria-pressed"] !== undefined);
    expect(picks).toHaveLength(APPROVAL_CATEGORIES.length * 2);
    const pressed = picks.filter((node) => node.props["aria-pressed"] === true).map((node) => collectText(node));
    expect(pressed).toEqual(["ask", "ask", "allow", "ask", "ask", "ask"]);
    expect(text).toContain("save it");
    expect(text).toContain("change any of it later in settings");
  });

  it("shows a denied row as blocked, with neither side pressed nor offered", () => {
    const tree = ApprovalSetup({ ...props, stage: "detail", current: { ...current, delete: "deny" } });
    expect(collectText(tree)).toContain("blocked");
    const picks = buttons(tree).filter((node) => node.props["aria-pressed"] !== undefined);
    const pressed = picks.filter((node) => node.props["aria-pressed"] === true).map((node) => collectText(node));
    expect(pressed).toEqual(["ask", "ask", "ask", "ask", "ask"]);
    const disabled = picks.filter((node) => node.props.disabled === true).map((node) => collectText(node));
    expect(disabled).toEqual(["allow", "ask"]);
  });

  it("shows an explicit pick over the current policy and reports it with the row id", () => {
    const onChoose = vi.fn();
    const onSave = vi.fn();
    const tree = ApprovalSetup({ ...props, stage: "detail", choices: { shell: "auto" }, onChoose, onSave });
    const picks = buttons(tree).filter((node) => node.props["aria-pressed"] !== undefined);
    expect(collectText(picks[0])).toBe("allow");
    expect(picks[0].props["aria-pressed"]).toBe(true);
    picks[1].props.onClick?.();
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("shell", "ask");
    press(tree, "save it");
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("apologises when the account cannot edit the rules, and explains why on request", () => {
    const onWhy = vi.fn();
    const onClose = vi.fn();
    const blocked = ApprovalSetup({ ...props, stage: "blocked", blocked: "capability", onWhy, onClose });
    const text = collectText(blocked);
    expect(shipRows(blocked)).toHaveLength(0);
    expect(text).toContain("Sorry, but this user can't edit those settings.");
    expect(text).not.toContain("permission to change settings");
    press(blocked, "why?");
    press(blocked, "got it");
    expect(onWhy).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    const why = ApprovalSetup({ ...props, stage: "why", blocked: "capability" });
    expect(shipRows(why)).toHaveLength(1);
    expect(yourRows(why)).toEqual(["hank why?"]);
    expect(yourRows(ApprovalSetup({ ...props, stage: "ask" }))).toEqual([]);
    expect(collectText(why)).toContain("this account doesn't have the permission to change settings");
    expect(buttons(why).map((node) => collectText(node))).toEqual(["got it"]);
    expect(collectText(ApprovalSetup({ ...props, stage: "why", blocked: "policy" }))).toContain("can't rewrite safely");
  });

  it("holds the controls while saving and offers a retry after a failed save", () => {
    const saving = ApprovalSetup({ ...props, stage: "ask", saving: true });
    for (const node of buttons(saving)) expect(node.props.disabled).toBe(true);
    expect(collectText(saving)).toContain("saving…");
    const failedAsk = ApprovalSetup({ ...props, stage: "ask", error: "offline" });
    expect(collectText(failedAsk)).toContain("that didn't save: offline");
    const failed = ApprovalSetup({ ...props, stage: "detail", error: "offline" });
    expect(collectText(failed)).toContain("that didn't save: offline");
    expect(collectText(failed)).toContain("try again");
    for (const node of buttons(failed)) expect(node.props.disabled).toBe(false);
  });
});
