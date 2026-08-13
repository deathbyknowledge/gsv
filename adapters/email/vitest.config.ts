import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        workers: [
          {
            name: "gsv-mail-accounts-test",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export default class AccountsTest extends WorkerEntrypoint {
                async resolveHostname(hostname) {
                  if (!hostname.startsWith("active-")) return { found: false };
                  const handle = hostname.split(".")[0];
                  return {
                    found: true,
                    state: "active",
                    installationId: "installation_" + handle,
                    handle,
                    canonicalOrigin: "https://" + hostname,
                  };
                }
                async resolveInstallation(installationId) {
                  if (!installationId.startsWith("installation_")) {
                    return { found: false };
                  }
                  const handle = installationId.slice("installation_".length);
                  return {
                    found: true,
                    state: "active",
                    installationId,
                    handle,
                    canonicalOrigin: "https://" + handle + ".gsv.space",
                  };
                }
              }
            `,
          },
          {
            name: "gsv-mail-gateway-test",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              const accepted = new Map();
              const failedStorage = new Set();
              export default class GatewayTest extends WorkerEntrypoint {
                async acceptManagedInboundMail(installation, metadata, body) {
                  if (installation.installationId.length === 0) {
                    throw new Error("missing installation");
                  }
                  const reader = body.stream.getReader();
                  let length = 0;
                  const chunks = [];
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    length += value.byteLength;
                    chunks.push(value);
                  }
                  if (length !== metadata.rawSize || length !== body.length) {
                    throw new Error("raw body length mismatch");
                  }
                  const bytes = new Uint8Array(length);
                  let offset = 0;
                  for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                  }
                  const digestBytes = new Uint8Array(
                    await crypto.subtle.digest("SHA-256", bytes),
                  );
                  const digest = "sha256:" + [...digestBytes]
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
                  if (digest !== metadata.digest) {
                    throw new Error("raw body digest mismatch");
                  }
                  if (
                    metadata.subject === "retry storage"
                    && !failedStorage.has(metadata.intakeId)
                  ) {
                    failedStorage.add(metadata.intakeId);
                    return { messageId: "" };
                  }
                  const messageId = "message_" + metadata.intakeId;
                  accepted.set(
                    installation.installationId + ":" + metadata.intakeId,
                    messageId,
                  );
                  return { messageId };
                }
                async completeManagedInboundMail(installation, completion) {
                  if (
                    installation.installationId.length === 0
                    || !completion.messageId.startsWith("message_")
                    || completion.summary.summary.length === 0
                    || accepted.get(
                      installation.installationId + ":" + completion.intakeId
                    ) !== completion.messageId
                  ) {
                    throw new Error("invalid completion");
                  }
                }
              }
            `,
          },
          {
            name: "gsv-mail-inference-test",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export default class InferenceTest extends WorkerEntrypoint {
                async summarizeMail(input) {
                  if (!input.logicalRequestId.startsWith("summary:mail_")) {
                    throw new Error("invalid summary request");
                  }
                  return {
                    summary: "A test message arrived.",
                    category: "personal",
                    requiresAttention: true,
                    confidence: 0.9,
                  };
                }
              }
            `,
          },
        ],
        serviceBindings: {
          ACCOUNTS: "gsv-mail-accounts-test",
          GATEWAY: "gsv-mail-gateway-test",
          INFERENCE: "gsv-mail-inference-test",
        },
      },
    }),
  ],
});
