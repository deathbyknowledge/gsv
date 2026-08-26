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
              const installationResolveAttempts = new Map();
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
                  const attempts = (installationResolveAttempts.get(installationId) ?? 0) + 1;
                  installationResolveAttempts.set(installationId, attempts);
                  if (handle.includes("accounts-outage") && attempts <= 12) {
                    throw new Error("simulated Accounts outage");
                  }
                  if (handle.includes("missing-once") && attempts === 1) {
                    return { found: false };
                  }
                  if (handle.includes("became-inactive")) {
                    return {
                      found: true,
                      state: "restricted",
                      installationId,
                      handle,
                      canonicalOrigin: "https://" + handle + ".gsv.space",
                    };
                  }
                  const resolvedHandle = handle.includes("changed-handle")
                    ? attempts === 1 ? "hank" : "different-handle"
                    : handle.includes("accounts-outage")
                      ? "hank"
                      : handle.includes("missing-once")
                        ? "hank"
                      : handle.startsWith("outbound_")
                        ? "hank"
                        : handle;
                  return {
                    found: true,
                    state: "active",
                    installationId,
                    handle: resolvedHandle,
                    canonicalOrigin: "https://" + resolvedHandle + ".gsv.space",
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
              const failedOutboundCompletion = new Set();
              const outboundClaimAttempts = new Map();
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
                async claimManagedOutboundMail(installation, reference) {
                  if (
                    installation.installationId.length === 0
                    || reference.version !== 1
                  ) {
                    throw new Error("invalid outbound claim");
                  }
                  const key = installation.installationId + ":" + reference.outboundId;
                  const attempts = (outboundClaimAttempts.get(key) ?? 0) + 1;
                  outboundClaimAttempts.set(key, attempts);
                  if (
                    reference.outboundId.includes("claim-always-fails")
                    || (
                      (
                        reference.outboundId.includes("claim-retry-once")
                        || reference.outboundId.includes("changed-handle")
                      )
                      && attempts === 1
                    )
                  ) {
                    throw new Error("simulated outbound claim failure");
                  }
                  if (reference.outboundId.includes("gateway-body-unavailable")) {
                    return {
                      status: "settled",
                      completion: {
                        version: 1,
                        outboundId: reference.outboundId,
                        fingerprint: reference.fingerprint,
                        state: "failed",
                        errorCode: "body_unavailable",
                      },
                    };
                  }
                  if (reference.outboundId.includes("gateway-terminal-replay")) {
                    return {
                      status: "settled",
                      completion: {
                        version: 1,
                        outboundId: reference.outboundId,
                        fingerprint: reference.fingerprint,
                        state: "accepted",
                        providerMessageId: "provider_terminal",
                      },
                    };
                  }
                  if (reference.outboundId.includes("gateway-reference-mismatch")) {
                    return {
                      status: "rejected",
                      errorCode: "reference_mismatch",
                    };
                  }
                  const text = "Body for " + reference.outboundId;
                  const bytes = new TextEncoder().encode(text);
                  const digestBytes = new Uint8Array(
                    await crypto.subtle.digest("SHA-256", bytes),
                  );
                  const bodyDigest = "sha256:" + [...digestBytes]
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
                  return {
                    status: "ready",
                    draft: {
                      version: 1,
                      outboundId: reference.outboundId,
                      fingerprint: reference.fingerprint,
                      from: reference.outboundId.includes("invalid")
                        ? "invalid address"
                        : reference.outboundId.includes("sender-mismatch")
                          ? "attacker@gsv.space"
                        : "hank@gsv.space",
                      to: reference.outboundId.includes("oversized-address")
                        ? "é".repeat(160) + "@example.com"
                        : "recipient@example.com",
                      subject: reference.outboundId.includes("oversized-subject")
                        ? "é".repeat(500)
                        : "Subject for " + reference.outboundId,
                      bodyDigest: reference.outboundId.includes("body-corruption")
                        ? "sha256:" + "0".repeat(64)
                        : bodyDigest,
                      textSize: bytes.byteLength,
                      createdAt: Date.now(),
                      ...(reference.outboundId.includes("reply")
                        ? {
                            replyToMessageId: "message_original",
                            inReplyTo: "<original@example.com>",
                            references: "<older@example.com> <original@example.com>",
                          }
                        : {}),
                    },
                    body: {
                      length: bytes.byteLength,
                      stream: new Response(bytes).body,
                    },
                  };
                }
                async completeManagedOutboundMail(installation, completion) {
                  if (
                    installation.installationId.length === 0
                    || completion.version !== 1
                    || !["accepted", "failed", "unknown"].includes(completion.state)
                  ) {
                    throw new Error("invalid outbound completion");
                  }
                  const key = installation.installationId + ":" + completion.outboundId;
                  if (
                    completion.outboundId.includes("callback-retry")
                    && !failedOutboundCompletion.has(key)
                  ) {
                    failedOutboundCompletion.add(key);
                    throw new Error("simulated outbound completion failure");
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
              const summaries = new Map();
              export default class InferenceTest extends WorkerEntrypoint {
                async summarizeMail(input) {
                  if (!input.logicalRequestId.startsWith("summary:mail_")) {
                    throw new Error("invalid summary request");
                  }
                  if (
                    input.subject === "retry summary"
                    && input.logicalRequestId.endsWith(":attempt:1")
                  ) {
                    summaries.set(input.logicalRequestId, { state: "failed" });
                    throw new Error("simulated summary provider failure");
                  }
                  if (
                    input.subject === "invalid summary"
                    && input.logicalRequestId.endsWith(":attempt:1")
                  ) {
                    summaries.set(input.logicalRequestId, { state: "failed" });
                    return { summary: "invalid" };
                  }
                  const summary = {
                    summary: "A test message arrived.",
                    category: "personal",
                    requiresAttention: true,
                    confidence: 0.9,
                  };
                  summaries.set(input.logicalRequestId, {
                    state: "completed",
                    summary,
                  });
                  if (input.subject === "lost summary response") {
                    throw new Error("simulated RPC response loss");
                  }
                  return summary;
                }
                async getMailSummaryStatus(input) {
                  return summaries.get(input.logicalRequestId) ?? { state: "missing" };
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
