import { toChildArray, type ComponentChildren, type VNode } from "preact";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../../components/ui/Button";
import {
  ChatWorkSessionBanner,
  focusChatSessionTarget,
  workSessionClosedAnnouncement,
  workSessionOpenedAnnouncement,
} from "./ChatWorkSessionBanner";

function collectText(value: ComponentChildren): string {
  return toChildArray(value).map((child) => {
    if (typeof child === "string" || typeof child === "number") {
      return String(child);
    }
    return child && typeof child === "object" && "props" in child
      ? collectText((child as VNode).props.children)
      : "";
  }).filter(Boolean).join(" ");
}

describe("ChatWorkSessionBanner", () => {
  it("keeps the work title and personal return action unmistakable", () => {
    const onBack = vi.fn();
    const banner = ChatWorkSessionBanner({
      personalName: "Xanadu",
      title: "Audit release readiness",
      onBack,
    });
    const children = toChildArray(banner.props.children) as Array<VNode>;
    const backButton = children.find((child) => child.type === Button) as VNode<{
      label?: string;
      onClick?: () => void;
    }> | undefined;

    expect(banner.props["aria-label"]).toBe("Work session: Audit release readiness");
    expect(banner.props.tabIndex).toBe(-1);
    expect(collectText(banner)).toContain("WORK SESSION");
    expect(collectText(banner)).toContain("Audit release readiness");
    expect(collectText(banner)).toContain(
      "You're inside one piece of its work. Xanadu is still your personal intelligence.",
    );
    expect(backButton?.props.label).toBe("BACK TO XANADU");
    backButton?.props.onClick?.();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("labels administrative work without inventing a personal intelligence", () => {
    const banner = ChatWorkSessionBanner({
      personalName: null,
      title: "Repair runtime state",
      onBack: vi.fn(),
    });
    const children = toChildArray(banner.props.children) as Array<VNode>;
    const backButton = children.find((child) => child.type === Button) as VNode<{
      label?: string;
    }> | undefined;
    const text = collectText(banner);

    expect(text).toContain("WORK SESSION");
    expect(text).toContain("You're inside an internal work process.");
    expect(text).toContain("This account has no personal intelligence.");
    expect(text).not.toContain("is still your personal intelligence");
    expect(backButton?.props.label).toBe("BACK TO ADMINISTRATION");
  });

  it("announces entry and return with the personal boundary intact", () => {
    const session = {
      personalName: "Xanadu",
      title: "Audit release readiness",
    };

    expect(workSessionOpenedAnnouncement(session)).toBe(
      "Work session opened: Audit release readiness. Xanadu remains your personal intelligence.",
    );
    expect(workSessionClosedAnnouncement(session)).toBe(
      "Returned to Xanadu, your personal intelligence.",
    );
    expect(workSessionClosedAnnouncement({
      personalName: null,
      title: "Repair runtime state",
    })).toBe("Returned to administration.");
  });

  it("moves focus to the Work banner on entry and personal control on return", () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    const container = { querySelector } as unknown as HTMLElement;

    expect(focusChatSessionTarget(container, true)).toBe(true);
    expect(querySelector).toHaveBeenLastCalledWith(".gsv-chat-work-session");
    expect(focus).toHaveBeenCalledOnce();

    expect(focusChatSessionTarget(container, false)).toBe(true);
    expect(querySelector).toHaveBeenLastCalledWith(".gsv-chat-agent-main");
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
