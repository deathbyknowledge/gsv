import { describe, expect, it, vi } from "vitest";
import { executeSlackTargetShell } from "./slack-target-shell";

describe("Slack target shell mutations", () => {
  it("preserves a successful write when its authorization confirmation fails", async () => {
    let conversationChecks = 0;
    const methods: string[] = [];
    const slackFetch = vi.fn(async (input: RequestInfo | URL) => {
      const method = new URL(String(input)).pathname.split("/").at(-1);
      methods.push(method ?? "");
      if (method === "auth.test") {
        return Response.json({
          ok: true,
          team_id: "TWORK123",
          team: "Acme",
          user_id: "UALICE01",
          user: "alice",
        });
      }
      if (method === "conversations.info") {
        conversationChecks += 1;
        if (conversationChecks === 2) {
          return Response.json(
            { ok: false, error: "temporary_unavailable" },
            { status: 503 },
          );
        }
        return Response.json({
          ok: true,
          channel: {
            id: "CGENERAL1",
            name: "general",
            is_channel: true,
            is_member: true,
          },
        });
      }
      if (method === "chat.postMessage") {
        return Response.json({
          ok: true,
          channel: "CGENERAL1",
          ts: "1700000001.000100",
        });
      }
      return Response.json({ ok: false, error: "unknown_method" }, { status: 404 });
    });
    const guard = vi.fn(async () => {});

    await expect(executeSlackTargetShell({
      args: {
        input: "slack messages send --channel CGENERAL1 --message 'hello from target'",
      },
      userToken: "xoxp-valid-user-token-value",
      botToken: "xoxb-valid-bot-token-value",
      actorId: "UALICE01",
      botUserId: "UGSVBOT1",
      teamId: "TWORK123",
      teamName: "Acme",
      signal: new AbortController().signal,
      slackFetch,
      guard,
    })).resolves.toMatchObject({
      status: "completed",
      output: "sent CGENERAL1 1700000001.000100\n",
      exitCode: 0,
    });
    expect(methods).toEqual([
      "auth.test",
      "conversations.info",
      "chat.postMessage",
      "conversations.info",
    ]);
    expect(methods.filter((method) => method === "chat.postMessage")).toHaveLength(1);
    expect(guard).toHaveBeenCalledTimes(2);
  });
});
