/**
 * GSV Gateway Infrastructure Definition
 * 
 * This file defines the Cloudflare resources for GSV using Alchemy.
 * Can be used for both deployments and e2e testing.
 */
import {
  Worker,
  DurableObjectNamespace,
  R2Bucket,
} from "alchemy/cloudflare";

export type GsvInfraOptions = {
  /** Unique name prefix (use random suffix for tests) */
  name: string;
  /** Worker entrypoint */
  entrypoint?: string;
  /** Enable public URL (for testing) */
  url?: boolean;
};

export async function createGsvInfra(opts: GsvInfraOptions) {
  const { name, entrypoint = "src/index.ts", url = false } = opts;

  // R2 bucket for storage (sessions, skills, media)
  // adopt: true allows alchemy to take over existing resources
  const storage = await R2Bucket(`${name}-storage`, {
    name: `${name}-storage`,
    adopt: true,
  });

  // Main gateway worker with all bindings
  // adopt: true allows alchemy to take over existing workers
  const gateway = await Worker(`${name}-worker`, {
    name,
    entrypoint,
    adopt: true,
    bindings: {
      GATEWAY: DurableObjectNamespace("gateway", {
        className: "Gateway",
        sqlite: true,
      }),
      SESSION: DurableObjectNamespace("session", {
        className: "Session",
        sqlite: true,
      }),
      STORAGE: storage,
      // AI binding for transcription (Workers AI)
      // Note: This uses your Cloudflare account's AI
    },
    url,
    compatibilityDate: "2025-02-11",
    compatibilityFlags: ["nodejs_compat"],
    bundle: {
      format: "esm",
      target: "es2022",
    },
  });

  return { gateway, storage };
}
