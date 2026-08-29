import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.managed.test.jsonc" },
      miniflare: {
        workers: [
          {
            name: "managed-slack-gateway-test",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              const calls = [];
              export class AdapterGatewayEntrypoint extends WorkerEntrypoint {
                async serviceFrame(installation, frame) {
                  const mediaBody = frame.body
                    ? Array.from(new Uint8Array(await new Response(frame.body.stream).arrayBuffer()))
                    : undefined;
                  calls.push({ installation, call: frame.call, args: frame.args, mediaBody });
                  return {
                    type: "res",
                    id: frame.id,
                    ok: true,
                    data: {
                      ok: true,
                      reply: {
                        deliveryId: "gateway-reply:" + frame.args.deliveryId,
                        text: "Reply for " + frame.args.message.actor.id,
                        replyToId: frame.args.message.messageId,
                      },
                    },
                  };
                }
                async unlinkManagedAdapterIdentity(installation, input) {
                  calls.push({ call: "unlinkManagedAdapterIdentity", installation, input });
                  return { removed: true };
                }
                async fetch() {
                  return Response.json(calls);
                }
              }
            `,
          },
          {
            name: "managed-slack-api-test",
            modules: true,
            script: `
              const calls = [];
              let nextTs = 1700001000;
              let nextFile = 0;
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/calls") {
                    return Response.json(calls);
                  }
                  if (request.method === "GET" && url.pathname.startsWith("/files-pri/")) {
                    const bytes = new TextEncoder().encode("managed inbound file");
                    calls.push({
                      method: "file.download",
                      body: { authorization: request.headers.get("Authorization") },
                    });
                    return new Response(bytes, {
                      headers: { "Content-Length": String(bytes.byteLength) },
                    });
                  }
                  if (request.method === "POST" && url.pathname.startsWith("/upload/v1/")) {
                    const bytes = new Uint8Array(await request.arrayBuffer());
                    calls.push({ method: "file.upload", body: { bytes: Array.from(bytes) } });
                    return new Response("OK");
                  }
                  const method = url.pathname.split("/").at(-1);
                  const contentType = request.headers.get("Content-Type") || "";
                  const body = request.method === "GET"
                    ? Object.fromEntries(url.searchParams)
                    : contentType.startsWith("application/json")
                      ? await request.json()
                      : Object.fromEntries(await request.formData());
                  calls.push({
                    method,
                    body: {
                      ...body,
                      authorization: request.headers.get("Authorization"),
                    },
                  });
                  if (method === "oauth.v2.access") {
                    return Response.json({
                      ok: true,
                      access_token: "xoxb-managed-test-token",
                      bot_user_id: "UGSVBOT1",
                      app_id: "AGSV1234",
                      scope: "app_mentions:read,chat:write,chat:write.public,files:read,files:write,im:history,im:write,reactions:write",
                      authed_user: {
                        id: "UALICE01",
                        access_token: "xoxp-managed-alice-user-token",
                        scope: "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read",
                      },
                      is_enterprise_install: false,
                      team: { id: "TWORK123", name: "Acme" },
                    });
                  }
                  if (method === "auth.test") {
                    return Response.json({
                      ok: true,
                      team_id: "TWORK123",
                      team: "Acme",
                      user_id: "UALICE01",
                      user: "alice",
                    });
                  }
                  if (method === "conversations.list") {
                    if (body.cursor === "wait-for-cancel") {
                      await new Promise((resolve, reject) => {
                        const timer = setTimeout(resolve, 5_000);
                        const abort = () => {
                          clearTimeout(timer);
                          reject(request.signal.reason || new Error("cancelled"));
                        };
                        request.signal.addEventListener("abort", abort, { once: true });
                        if (request.signal.aborted) abort();
                      });
                    }
                    const channels = body.types === "im"
                      ? [{
                          id: "DGSVBOT1",
                          user: "UGSVBOT1",
                          is_im: true,
                          is_private: true,
                        }]
                      : [{
                          id: "CGENERAL1",
                          name: "general",
                          is_member: true,
                          is_private: false,
                        }];
                    return Response.json({
                      ok: true,
                      channels,
                      response_metadata: { next_cursor: "" },
                    });
                  }
                  if (method === "conversations.history" || method === "conversations.replies") {
                    return Response.json({
                      ok: true,
                      messages: [{
                        ts: "1700000001.000100",
                        user: "UALICE01",
                        text: "Hello from Slack",
                      }],
                      response_metadata: { next_cursor: "" },
                    });
                  }
                  if (method === "reactions.add") return Response.json({ ok: true });
                  if (method === "users.list") {
                    return Response.json({
                      ok: true,
                      members: [{
                        id: "UALICE01",
                        name: "alice",
                        real_name: "Alice",
                        profile: { display_name: "Alice" },
                      }],
                      response_metadata: { next_cursor: "" },
                    });
                  }
                  if (method === "users.info") {
                    return Response.json({
                      ok: true,
                      user: {
                        id: body.user,
                        name: "alice",
                        real_name: "Alice",
                        profile: { display_name: "Alice" },
                      },
                    });
                  }
                  if (method === "conversations.open") {
                    const channels = { UALICE01: "DALICE01", UBOB0001: "DBOB0001" };
                    return Response.json({
                      ok: true,
                      channel: { id: channels[body.users] || "DUNKNOWN1" },
                    });
                  }
                  if (method === "chat.postMessage") {
                    nextTs += 1;
                    return Response.json({
                      ok: true,
                      channel: body.channel,
                      ts: String(nextTs) + ".000100",
                    });
                  }
                  if (method === "chat.update") {
                    return Response.json({
                      ok: true,
                      channel: body.channel,
                      ts: body.ts,
                    });
                  }
                  if (method === "files.info") {
                    const bytes = new TextEncoder().encode("managed inbound file");
                    return Response.json({
                      ok: true,
                      file: {
                        id: body.file,
                        name: "managed.txt",
                        mimetype: "text/plain",
                        size: bytes.byteLength,
                        url_private_download: "https://files.slack.com/files-pri/TWORK123-FFILE001/managed.txt",
                      },
                    });
                  }
                  if (method === "files.getUploadURLExternal") {
                    nextFile += 1;
                    const fileId = "FUPLOAD" + nextFile;
                    return Response.json({
                      ok: true,
                      upload_url: "https://files.slack.com/upload/v1/" + fileId,
                      file_id: fileId,
                    });
                  }
                  if (method === "files.completeUploadExternal") {
                    if (body.initial_comment?.includes("Membership failure")) {
                      return Response.json({ ok: false, error: "not_in_channel" });
                    }
                    return Response.json({ ok: true, files: body.files });
                  }
                  return Response.json({ ok: false, error: "unknown_method" });
                },
              };
            `,
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/managed-flow.test.ts"],
  },
});
