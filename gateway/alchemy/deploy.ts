#!/usr/bin/env tsx
/**
 * Deploy GSV Gateway using Alchemy
 * 
 * Usage: 
 *   bun run deploy:alchemy              # Deploy gateway with UI
 *   bun run deploy:alchemy --whatsapp   # Deploy gateway + WhatsApp channel
 *   bun run deploy:alchemy --discord    # Deploy gateway + Discord channel
 *   bun run deploy:alchemy --templates  # Deploy + upload workspace templates
 *   bun run deploy:alchemy --no-ui      # Deploy without web UI
 *   bun run deploy:alchemy --destroy    # Tear down resources
 * 
 * Environment variables:
 *   AUTH_TOKEN          - Auth token for Gateway & channels (auto-generated if not set)
 *   DISCORD_BOT_TOKEN   - Discord bot token (required for --discord)
 * 
 * Note: LLM API keys (Anthropic, OpenAI, etc.) are configured via CLI after deployment:
 *   gsv config set apiKeys.anthropic sk-ant-...
 */
import alchemy from "alchemy";
import { randomBytes } from "node:crypto";
import { createGsvInfra } from "./infra.ts";

const STACK_NAME = "gsv";
const WORKER_NAME = "gateway";

const withWhatsApp = process.argv.includes("--whatsapp");
const withDiscord = process.argv.includes("--discord");
const withTemplates = process.argv.includes("--templates");
const withUI = !process.argv.includes("--no-ui"); // UI included by default
const isDestroy = process.argv.includes("--destroy");

// Generate AUTH_TOKEN if not provided
const authToken = process.env.AUTH_TOKEN || randomBytes(32).toString("hex");
const discordBotToken = process.env.DISCORD_BOT_TOKEN;

console.log(`\n🚀 GSV Deployment`);
console.log(`   Stack: ${STACK_NAME}`);
console.log(`   Web UI: ${withUI ? "yes" : "no"}`);
console.log(`   WhatsApp: ${withWhatsApp ? "yes" : "no"}`);
console.log(`   Discord: ${withDiscord ? "yes" : "no"}`);
console.log(`   Templates: ${withTemplates ? "yes" : "no"}`);
console.log(`   Auth Token: ${process.env.AUTH_TOKEN ? "from env" : "auto-generated"}`);
if (withDiscord) {
  console.log(`   Discord Token: ${discordBotToken ? "configured" : "NOT SET ⚠️"}`);
}
console.log("");

const app = await alchemy(STACK_NAME, {
  phase: isDestroy ? "destroy" : "up",
  stateDir: ".alchemy",
  // Password for encrypting secrets in state files
  password: process.env.ALCHEMY_PASSWORD || "gsv-deploy-secrets",
});

const { gateway, storage, whatsappChannel, discordChannel } = await createGsvInfra({
  name: WORKER_NAME,
  entrypoint: "src/index.ts",
  url: true,
  withWhatsApp,
  withDiscord,
  withTemplates,
  withUI,
  secrets: {
    authToken,
    discordBotToken,
  },
});

if (!isDestroy) {
  console.log("\n✅ Deployed successfully!\n");
  console.log(`   Gateway:  ${gateway.url}`);
  if (withUI) {
    console.log(`   Web UI:   ${gateway.url}`);
  }
  console.log(`   Storage:  ${storage.name}`);
  
  if (whatsappChannel) {
    console.log(`   WhatsApp: ${whatsappChannel.url}`);
  }
  
  if (discordChannel) {
    console.log(`   Discord:  ${discordChannel.url}`);
  }

  // Print auth token if it was auto-generated
  if (!process.env.AUTH_TOKEN) {
    console.log("\n🔑 Generated Auth Token (save this!):");
    console.log(`   ${authToken}`);
  }

  // Print CLI config commands
  console.log("\n📋 Configure CLI:");
  console.log(`   gsv init`);
  console.log(`   gsv local-config set gateway.url ${gateway.url?.replace("https://", "wss://")}/ws`);
  console.log(`   gsv local-config set gateway.token ${authToken}`);
  console.log("");
  console.log("   Then set your LLM API key:");
  console.log(`   gsv config set apiKeys.anthropic sk-ant-...`);
  
  if (whatsappChannel) {
    console.log(`   gsv local-config set channels.whatsapp.url ${whatsappChannel.url}`);
    console.log(`   gsv local-config set channels.whatsapp.token ${authToken}`);
    console.log("");
    console.log("   Then login to WhatsApp:");
    console.log(`   gsv channel whatsapp login`);
  }
  
  if (discordChannel) {
    console.log("");
    console.log("   Discord bot setup:");
    console.log(`   curl ${discordChannel.url}/setup`);
    console.log(`   curl -X POST ${discordChannel.url}/start`);
  }
  
  console.log("");
} else {
  console.log("\n✅ Resources destroyed!");
}
