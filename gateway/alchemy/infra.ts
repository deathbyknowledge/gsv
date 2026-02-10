/**
 * GSV Gateway Infrastructure Definition
 *
 * This file defines the Cloudflare resources for GSV using Alchemy.
 * Can be used for both deployments and e2e testing.
 */
import {
  Worker,
  WorkerStub,
  DurableObjectNamespace,
  R2Bucket,
  R2Object,
  Queue,
  Assets,
  Ai,
} from "alchemy/cloudflare";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve paths relative to this file (gateway/alchemy/)
const GATEWAY_DIR = path.resolve(__dirname, "..");
const CHANNELS_DIR = path.resolve(__dirname, "../../channels");

export type GsvInfraOptions = {
  /** Unique name prefix (use random suffix for tests) */
  name: string;
  /** Worker entrypoint */
  entrypoint?: string;
  /** Enable public URL (for testing) */
  url?: boolean;
  /** Deploy test channel alongside Gateway */
  withTestChannel?: boolean;
  /** Deploy WhatsApp channel */
  withWhatsApp?: boolean;
  /** Deploy Discord channel */
  withDiscord?: boolean;
  /** Upload workspace templates */
  withTemplates?: boolean;
  /** Upload global skill templates only (without workspace templates) */
  withSkillTemplates?: boolean;
  /** Include web UI static assets */
  withUI?: boolean;
  /** Secrets to configure */
  secrets?: {
    discordBotToken?: string;
  };
};

export async function createGsvInfra(opts: GsvInfraOptions) {
  const {
    name,
    entrypoint = path.join(GATEWAY_DIR, "src/index.ts"),
    url = false,
    withTestChannel = false,
    withWhatsApp = false,
    withDiscord = false,
    withTemplates = false,
    withSkillTemplates = false,
    withUI = false,
    secrets = {},
  } = opts;

  // R2 bucket for storage (sessions, skills, media)
  const storage = await R2Bucket(`${name}-storage`, {
    name: `${name}-storage`,
    adopt: true,
  });

  // Upload workspace templates if requested
  if (withTemplates) {
    console.log("📁 Uploading workspace templates...");
    await uploadWorkspaceTemplates(storage);
  }

  // Upload global skill templates if requested
  if (withTemplates || withSkillTemplates) {
    console.log("📚 Uploading skill templates...");
    await uploadSkillTemplates(storage);
  }

  // Build and create assets for web UI
  let uiAssets: Awaited<ReturnType<typeof Assets>> | undefined;
  if (withUI) {
    console.log("🎨 Building web UI...");
    const uiDir = path.join(GATEWAY_DIR, "ui");
    const { execSync } = await import("node:child_process");

    // Install dependencies and build
    execSync("npm install && npm run build", {
      cwd: uiDir,
      stdio: "inherit",
    });

    uiAssets = await Assets({
      path: path.join(uiDir, "dist"),
    });
    console.log("   UI assets ready");
  }

  // Channel inbound queue - all channels send inbound messages here
  // Gateway consumes from this queue to process messages
  // Settings optimized for minimal latency
  const channelInboundQueue = await Queue(`${name}-channel-inbound`, {
    name: `${name}-channel-inbound`,
    adopt: true,
    settings: {
      deliveryDelay: 0, // No delay before delivery
    },
  });

  // =========================================================================
  // Deploy channels FIRST (Gateway references them via service bindings)
  // =========================================================================

  // Optional test channel for e2e testing
  let testChannel: Awaited<ReturnType<typeof Worker>> | undefined;

  if (withTestChannel) {
    testChannel = await Worker(`${name}-test-channel`, {
      name: `${name}-test-channel`,
      entrypoint: path.join(CHANNELS_DIR, "test/src/index.ts"),
      adopt: true,
      bindings: {
        // Queue for sending inbound messages to Gateway (producer binding)
        GATEWAY_QUEUE: channelInboundQueue,
        // Durable Object for maintaining test state across requests
        TEST_CHANNEL_STATE: DurableObjectNamespace("test-channel-state", {
          className: "TestChannelState",
        }),
      },
      url: true,
      compatibilityDate: "2025-09-01",
      compatibilityFlags: ["nodejs_compat"],
    });
  }

  // Deploy WhatsApp channel
  let whatsappChannel: Awaited<ReturnType<typeof Worker>> | undefined;

  if (withWhatsApp) {
    whatsappChannel = await Worker(`${name}-channel-whatsapp`, {
      name: `${name}-channel-whatsapp`,
      entrypoint: path.join(CHANNELS_DIR, "whatsapp/src/index.ts"),
      adopt: true,
      bindings: {
        WHATSAPP_ACCOUNT: DurableObjectNamespace("whatsapp-account", {
          className: "WhatsAppAccount",
          sqlite: true,
        }),
        // Queue for sending inbound messages to Gateway (producer binding)
        GATEWAY_QUEUE: channelInboundQueue,
      },
      url: true,
      compatibilityDate: "2025-09-21",
      compatibilityFlags: ["nodejs_compat"],
      bundle: {
        alias: {
          ws: path.join(CHANNELS_DIR, "whatsapp/src/ws-shim.ts"),
          axios: path.join(CHANNELS_DIR, "whatsapp/src/axios-shim.ts"),
        },
      },
    });
  }

  // Deploy Discord channel
  let discordChannel: Awaited<ReturnType<typeof Worker>> | undefined;

  if (withDiscord) {
    discordChannel = await Worker(`${name}-channel-discord`, {
      name: `${name}-channel-discord`,
      entrypoint: path.join(CHANNELS_DIR, "discord/src/index.ts"),
      adopt: true,
      bindings: {
        DISCORD_GATEWAY: DurableObjectNamespace("discord-gateway", {
          className: "DiscordGateway",
          sqlite: true,
        }),
        // Queue for sending inbound messages to Gateway (producer binding)
        GATEWAY_QUEUE: channelInboundQueue,
        ...(secrets.discordBotToken
          ? { DISCORD_BOT_TOKEN: secrets.discordBotToken }
          : {}),
      },
      url: true,
      compatibilityDate: "2025-02-11",
      compatibilityFlags: ["nodejs_compat"],
    });
  }

  // =========================================================================
  // Deploy Gateway AFTER channels (so service bindings can resolve)
  // =========================================================================

  // Workers AI for audio transcription (free)
  const ai = Ai();

  // Main gateway worker - consumes from channel inbound queue
  const gateway = await Worker(`${name}-worker`, {
    name,
    entrypoint,
    adopt: true,
    ...(uiAssets
      ? { assets: { not_found_handling: "single-page-application" } }
      : {}),
    bindings: {
      AI: ai,
      GATEWAY: DurableObjectNamespace("gateway", {
        className: "Gateway",
        sqlite: true,
      }),
      SESSION: DurableObjectNamespace("session", {
        className: "Session",
        sqlite: true,
      }),
      STORAGE: storage,
      // Web UI static assets
      ...(uiAssets ? { ASSETS: uiAssets } : {}),
      // Service bindings to channels (for outbound messages)
      // Points to channel WorkerEntrypoints for RPC methods (send, setTyping, etc.)
      ...(withWhatsApp
        ? {
            CHANNEL_WHATSAPP: {
              type: "service" as const,
              service: `${name}-channel-whatsapp`,
              __entrypoint__: "WhatsAppChannelEntrypoint",
            },
          }
        : {}),
      ...(withTestChannel
        ? {
            CHANNEL_TEST: {
              type: "service" as const,
              service: `${name}-test-channel`,
              __entrypoint__: "TestChannel",
            },
          }
        : {}),
      ...(withDiscord
        ? {
            CHANNEL_DISCORD: {
              type: "service" as const,
              service: `${name}-channel-discord`,
              __entrypoint__: "DiscordChannel",
            },
          }
        : {}),
    },
    // Queue consumer: process inbound messages from channels
    eventSources: [
      {
        queue: channelInboundQueue,
        settings: {
          batchSize: 1, // Process one message at a time for minimal latency
          maxRetries: 3,
          maxWaitTimeMs: 0, // Don't wait to batch, process immediately
        },
      },
    ],
    url,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
  });

  return { gateway, storage, whatsappChannel, testChannel, discordChannel };
}

/**
 * Upload workspace templates to R2 bucket
 */
async function uploadWorkspaceTemplates(
  bucket: Awaited<ReturnType<typeof R2Bucket>>,
  agentId: string = "main",
): Promise<void> {
  const files = [
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "MEMORY.md",
    "AGENTS.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
  ];
  // Templates are at repo root: gsv/templates/workspace/
  const templatesDir = path.resolve(__dirname, "../../templates/workspace");

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`   Template not found: ${file}`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const key = `agents/${agentId}/${file}`;

    await R2Object(`template-${agentId}-${file}`, {
      bucket,
      key,
      content,
    });

    console.log(`   Uploaded ${key}`);
  }
}

/**
 * Upload skill templates to R2 bucket (global skills)
 */
async function uploadSkillTemplates(
  bucket: Awaited<ReturnType<typeof R2Bucket>>,
): Promise<void> {
  // Skills are at repo root: gsv/templates/skills/
  const skillsDir = path.resolve(__dirname, "../../templates/skills");

  if (!fs.existsSync(skillsDir)) {
    console.warn("   Skills directory not found");
    return;
  }

  // List all skill directories
  const skillDirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  for (const skillName of skillDirs) {
    const skillFile = path.join(skillsDir, skillName, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      console.warn(`   Skill missing SKILL.md: ${skillName}`);
      continue;
    }

    const content = fs.readFileSync(skillFile, "utf-8");
    const key = `skills/${skillName}/SKILL.md`;

    await R2Object(`skill-${skillName}`, {
      bucket,
      key,
      content,
    });

    console.log(`   Uploaded ${key}`);
  }
}
