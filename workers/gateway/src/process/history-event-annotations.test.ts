import { describe, expect, it } from "vitest";
import type { EventReplyTarget, InteractionOrigin, ProcHistoryRecordData } from "@humansandmachines/gsv/protocol";
import { renderContextHistory, type ModelHistoryGroup } from "./history/model-renderer";

const slack: EventReplyTarget = {
  kind: "adapter", adapter: "slack", accountId: "account:fixture", actorId: "actor:fixture",
  surface: { kind: "thread", id: "room:fixture", threadId: "thread:fixture", name: "Fixture room" },
};
const slackOrigin: InteractionOrigin = { ...slack, actorLabel: "Fixture actor" };
const firedAtMs = 1_700_000_000_000;

function group(record: ProcHistoryRecordData, runId: string, origin?: InteractionOrigin): ModelHistoryGroup {
  return {
    messageId: 1, generation: 0, runId, createdAt: firedAtMs, records: [record], metadata: null, origin,
    compatibility: { text: "", media: [], mediaJson: null, hasMedia: false, isError: false, legacyImageContent: null },
  };
}

function user(text: string, runId: string, origin?: InteractionOrigin): ModelHistoryGroup {
  return group({ kind: "message", payload: { direction: "in", text, media: [], origin: {} } }, runId, origin);
}

function schedule(scheduleId: string, runId: string, replyTo?: EventReplyTarget): ModelHistoryGroup {
  return group({ kind: "event", payload: {
    kind: "schedule.fired", severity: "info", audience: "model",
    payload: { scheduleId, runId, scheduleName: "Fixture reminder", message: "Inspect the fixture.", firedAtMs, replyTo },
  } }, runId);
}

function render(groups: ModelHistoryGroup[]) {
  return renderContextHistory(groups.map((entry, index) => ({ ...entry, messageId: index + 1 })), {}, async () => {
    throw new Error("Fixture has no media to hydrate");
  });
}

describe("model event origin annotations", () => {
  it("renders one schedule destination from its typed payload without origin and restores the following default destination", async () => {
    const scheduled = schedule("schedule:fixture", "run:scheduled", slack);
    expect(scheduled.origin).toBeUndefined();
    const messages = await render([
      user("Earlier process request.", "run:before"),
      scheduled,
      user("Following process request.", "run:after"),
    ]);
    expect(messages[1]?.content).toBe([
      "[GSV EVENT]",
      "Schedule `Fixture reminder` fired.",
      "ID: `schedule:fixture`",
      "Reply destination: this Slack thread.",
      "Fired: 2023-11-14T22:13:20.000Z",
      "",
      "Inspect the fixture.",
    ].join("\n"));
    expect(messages[2]?.content).toBe("[Directed endpoint: this GSV process.]\nFollowing process request.");
  });

  it.each([true, false])("tracks only explicit destination changes between schedules sharing one run: second targets Slack %s", async (secondTargetsSlack) => {
    const first = schedule("schedule:first", "run:shared", secondTargetsSlack ? undefined : slack);
    const second = schedule("schedule:second", "run:shared", secondTargetsSlack ? slack : undefined);
    const following = user("Following request.", "run:following", secondTargetsSlack ? undefined : slackOrigin);
    const messages = await render([first, second, following]);
    if (secondTargetsSlack) {
      expect(messages[0]?.content).not.toContain("Reply destination:");
      expect(messages[0]?.content).toContain("[Directed endpoint: this GSV process.]");
      expect(messages[1]?.content).toContain("Reply destination: this Slack thread.");
    } else {
      expect(messages[0]?.content).toContain("Reply destination: this Slack thread.");
      expect(messages[1]?.content).not.toContain("Reply destination:");
    }
    for (const message of messages.slice(0, 2)) {
      expect(message.content).not.toContain("[From:");
    }
    expect(messages[1]?.content).not.toContain("[Directed endpoint:");
    expect(messages[2]?.content).toBe(secondTargetsSlack
      ? "[Directed endpoint: this GSV process.]\nFollowing request."
      : "[From: Slack thread Fixture room thread thread:fixture from Fixture actor]\nFollowing request.");
  });

  it("keeps a busy Slack run's endpoint when a schedule arrives without replyTo", async () => {
    const messages = await render([
      user("Active Slack request.", "run:busy", slackOrigin),
      schedule("schedule:busy", "run:busy"),
      user("Later Slack request.", "run:later", slackOrigin),
    ]);
    expect(messages[0]?.content).toContain("[Directed endpoint: this Slack thread.]");
    expect(messages[1]?.content).toBe([
      "[GSV EVENT]",
      "Schedule `Fixture reminder` fired.",
      "ID: `schedule:busy`",
      "Fired: 2023-11-14T22:13:20.000Z",
      "",
      "Inspect the fixture.",
    ].join("\n"));
    expect(messages[2]?.content).toBe("[From: Slack thread Fixture room thread thread:fixture from Fixture actor]\nLater Slack request.");
  });

  it("puts the event marker before adapter annotations and the event body", async () => {
    const messages = await render([
      group({ kind: "event", payload: {
        kind: "legacy", payload: { text: "A fixture event body." }, severity: "info", audience: "model",
      } }, "run:event", slackOrigin),
      user("Same destination afterwards.", "run:user", slackOrigin),
    ]);
    expect(messages[0]?.content).toBe([
      "[GSV EVENT]",
      "[From: Slack thread Fixture room thread thread:fixture from Fixture actor]",
      "[Directed endpoint: this Slack thread.]",
      "A fixture event body.",
    ].join("\n"));
    expect(messages[1]?.content).toBe("Same destination afterwards.");
  });

  it("remembers a schedule source even while suppressing its generic annotations", async () => {
    const messages = await render([
      schedule("schedule:fixture", "run:schedule", slack),
      group({ kind: "event", payload: {
        kind: "legacy", payload: { text: "A follow-up fixture event." }, severity: "info", audience: "model",
      } }, "run:followup", { kind: "scheduler", scheduleId: "schedule:fixture", replyTo: slack }),
    ]);
    expect(messages[1]?.content).toBe("[GSV EVENT]\nA follow-up fixture event.");
  });

  it("preserves ordinary user prefixes, source suppression, and original whitespace", async () => {
    const browser: InteractionOrigin = { kind: "client", connectionId: "client:fixture", clientId: "gsv-ui" };
    const messages = await render([
      user("  First user request.  ", "run:first", browser),
      user("Second user request.", "run:second", browser),
      user("Third user request.", "run:third", slackOrigin),
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      "[From: GSV Web Desktop]\n[Directed endpoint: this GSV client.]\n  First user request.  ",
      "Second user request.",
      "[From: Slack thread Fixture room thread thread:fixture from Fixture actor]\n[Directed endpoint: this Slack thread.]\nThird user request.",
    ]);
  });
});
