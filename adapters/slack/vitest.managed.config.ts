import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { slackApiWorkerScript } from "./test/fixture-workers.ts";

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
                  if (frame.call === "adapter.state.update") {
                    return { type: "res", id: frame.id, ok: true, data: { ok: true } };
                  }
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
            script: slackApiWorkerScript("managed"),
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/managed-flow.test.ts"],
  },
});
