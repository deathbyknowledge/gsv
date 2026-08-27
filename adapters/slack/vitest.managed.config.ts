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
                  calls.push({ installation, call: frame.call, args: frame.args });
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
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === "GET" && url.pathname === "/calls") {
                    return Response.json(calls);
                  }
                  const method = url.pathname.split("/").at(-1);
                  const contentType = request.headers.get("Content-Type") || "";
                  const body = contentType.startsWith("application/json")
                    ? await request.json()
                    : Object.fromEntries(await request.formData());
                  calls.push({ method, body });
                  if (method === "oauth.v2.access") {
                    return Response.json({
                      ok: true,
                      access_token: "xoxb-managed-test-token",
                      bot_user_id: "UGSVBOT1",
                      app_id: "AGSV1234",
                      scope: "app_mentions:read,chat:write,im:history,im:write",
                      is_enterprise_install: false,
                      team: { id: "TWORK123", name: "Acme" },
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
