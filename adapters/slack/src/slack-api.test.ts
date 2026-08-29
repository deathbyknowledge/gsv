import { describe, expect, it, vi } from "vitest";
import {
  downloadSlackFile,
  exchangeSlackOAuthCode,
  slackFileDeliveryErrorMessage,
  SlackApiError,
  uploadSlackFiles,
} from "./slack-api";

describe("Slack OAuth API", () => {
  it("retains the authorizing user's token separately from the bot installation", async () => {
    const provider = vi.fn(async () => Response.json({
      ok: true,
      access_token: "xoxb-valid-bot-token-value",
      bot_user_id: "UGSVBOT1",
      app_id: "AGSV1234",
      scope: "chat:write",
      team: { id: "TWORK123", name: "Acme" },
      authed_user: {
        id: "UALICE01",
        access_token: "xoxp-valid-user-token-value",
        scope: "channels:read,chat:write",
      },
    }));

    await expect(exchangeSlackOAuthCode({
      clientId: "12345.67890",
      clientSecret: "client-secret-value",
      code: "oauth-code",
      redirectUri: "https://slack.gsv.test/slack/oauth/callback",
    }, provider)).resolves.toEqual({
      teamId: "TWORK123",
      teamName: "Acme",
      botUserId: "UGSVBOT1",
      botToken: "xoxb-valid-bot-token-value",
      appId: "AGSV1234",
      scope: "chat:write",
      user: {
        id: "UALICE01",
        token: "xoxp-valid-user-token-value",
        scope: "channels:read,chat:write",
      },
    });
  });
});

describe("Slack file delivery errors", () => {
  it("turns a channel-membership rejection into recovery guidance", () => {
    expect(slackFileDeliveryErrorMessage(
      new SlackApiError("provider detail", "permanent", "not_in_channel"),
    )).toBe("Invite the GSV app to this Slack conversation before sharing files");
  });

  it("does not expose unknown provider errors", () => {
    expect(slackFileDeliveryErrorMessage(
      new SlackApiError("private provider detail", "permanent", "unexpected_detail"),
    )).toBe("Slack file delivery failed");
  });
});

describe("Slack file API", () => {
  it("downloads authenticated private files from fresh Slack metadata", async () => {
    const bytes = new TextEncoder().encode("hello slack");
    const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files.info")) {
        expect(JSON.parse(String(init?.body))).toEqual({ file: "FFILE001" });
        return Response.json({
          ok: true,
          file: {
            id: "FFILE001",
            name: "notes.txt",
            mimetype: "text/plain",
            size: bytes.byteLength,
            url_private_download: "https://files.slack.com/files-pri/TWORK123-FFILE001/notes.txt",
          },
        });
      }
      expect(url.hostname).toBe("files.slack.com");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer xoxb-valid-token-value",
      });
      return new Response(bytes, {
        headers: { "Content-Length": String(bytes.byteLength) },
      });
    });

    const file = await downloadSlackFile(
      "xoxb-valid-token-value",
      "FFILE001",
      1_024,
      provider,
    );
    expect(file).toMatchObject({
      fileId: "FFILE001",
      filename: "notes.txt",
      mimeType: "text/plain",
      size: bytes.byteLength,
    });
    await expect(new Response(file.body.stream).text()).resolves.toBe("hello slack");
  });

  it("never sends the bot token to a non-Slack file URL", async () => {
    const provider = vi.fn(async () => Response.json({
      ok: true,
      file: {
        id: "FFILE001",
        name: "notes.txt",
        mimetype: "text/plain",
        size: 5,
        url_private_download: "https://attacker.example/notes.txt",
      },
    }));
    await expect(downloadSlackFile(
      "xoxb-valid-token-value",
      "FFILE001",
      1_024,
      provider,
    )).rejects.toThrow("Slack file download URL is invalid");
    expect(provider).toHaveBeenCalledOnce();
  });

  it("uploads a threaded file batch and completes it once", async () => {
    const uploaded: string[] = [];
    const completed = vi.fn();
    let ticket = 0;
    const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files.getUploadURLExternal")) {
        ticket += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.length).toBeGreaterThan(0);
        return Response.json({
          ok: true,
          upload_url: `https://files.slack.com/upload/v1/${ticket}`,
          file_id: ticket === 1 ? "FFILE001" : "FFILE002",
        });
      }
      if (url.pathname.startsWith("/upload/v1/")) {
        uploaded.push(await new Response(init?.body).text());
        return new Response("OK");
      }
      if (url.pathname.endsWith("/files.completeUploadExternal")) {
        const body = JSON.parse(String(init?.body));
        completed(body);
        return Response.json({
          ok: true,
          files: [{ id: "FFILE001" }, { id: "FFILE002" }],
        });
      }
      return Response.json({ ok: false, error: "unknown_method" }, { status: 404 });
    });

    await expect(uploadSlackFiles("xoxb-valid-token-value", {
      channel: "CGENERAL1",
      text: "Attached",
      threadTs: "1700000000.000100",
      files: [
        {
          filename: "first.txt",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("first"),
        },
        {
          filename: "second.txt",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("second"),
        },
      ],
    }, provider)).resolves.toEqual({ fileIds: ["FFILE001", "FFILE002"] });
    expect(uploaded).toEqual(["first", "second"]);
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith({
      channel_id: "CGENERAL1",
      files: [{ id: "FFILE001" }, { id: "FFILE002" }],
      initial_comment: "Attached",
      thread_ts: "1700000000.000100",
    });
  });
});
