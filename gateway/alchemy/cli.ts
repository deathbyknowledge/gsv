#!/usr/bin/env bun
/**
 * GSV Deployment CLI
 * 
 * Unified entry point for deploying, upgrading, and destroying GSV infrastructure.
 * 
 * Usage:
 *   bun alchemy/cli.ts              # Interactive wizard (first time)
 *   bun alchemy/cli.ts              # Re-deploy with saved config (after first deploy)
 *   bun alchemy/cli.ts wizard       # Force interactive wizard
 *   bun alchemy/cli.ts up           # Re-deploy (same as no args after first deploy)
 *   bun alchemy/cli.ts destroy      # Tear down all resources
 *   bun alchemy/cli.ts status       # Show deployment status
 * 
 * Options:
 *   --name <name>       Stack name (default: gsv)
 *   --quick, -q         QuickStart mode for wizard
 *   --help, -h          Show help
 */

import alchemy from "alchemy";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { createGsvInfra, type GsvInfraOptions } from "./infra";
import { runWizard } from "./wizard/index";
import { createCliPrompter, isCancelled, handleCancel } from "./wizard/prompter";
import type { WizardState } from "./wizard/types";

const DISCORD_INVITE_PERMISSIONS = 101376; // View Channels + Send Messages + Attach Files + Read Message History

// ============================================================================
// State Management
// ============================================================================

const STATE_DIR = ".alchemy";
const DEPLOY_STATE_FILE = "deploy-state.json";

interface DeployState {
  /** Stack name */
  stackName: string;
  /** Deployment options */
  options: {
    withWhatsApp: boolean;
    withDiscord: boolean;
    withTelegram: boolean;
    withTemplates: boolean;
    withUI: boolean;
  };
  /** Secrets (only stored if user opts in) */
  secrets?: {
    discordBotToken?: string;
    telegramBotToken?: string;
  };
  /** LLM config */
  llm?: {
    provider: string;
    model: string;
  };
  /** Deployment URLs (for display) */
  urls?: {
    gateway?: string;
    whatsapp?: string;
    discord?: string;
    telegram?: string;
  };
  /** Last deployment timestamp */
  deployedAt?: string;
}

/**
 * Find the alchemy state directory.
 * Looks for the deploy-state.json file specifically, checking cwd then parent.
 */
function findStateDir(): string {
  const cwdState = join(process.cwd(), STATE_DIR);
  const cwdDeployState = join(cwdState, DEPLOY_STATE_FILE);
  
  // Check cwd first - if deploy-state.json exists there, use it
  if (existsSync(cwdDeployState)) {
    return cwdState;
  }
  
  // Check parent directory (e.g., running from gateway/ when state is at repo root)
  const parentState = join(process.cwd(), "..", STATE_DIR);
  const parentDeployState = join(parentState, DEPLOY_STATE_FILE);
  if (existsSync(parentDeployState)) {
    return parentState;
  }
  
  // Default to cwd (will be created)
  return cwdState;
}

function getStatePath(stackName: string): string {
  return join(findStateDir(), DEPLOY_STATE_FILE);
}

function loadDeployState(stackName: string): DeployState | null {
  const path = getStatePath(stackName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function saveDeployState(state: DeployState): void {
  const dir = findStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, DEPLOY_STATE_FILE), JSON.stringify(state, null, 2));
}



// ============================================================================
// Commands
// ============================================================================

async function commandWizard(stackName: string, quick: boolean): Promise<void> {
  const result = await runWizard({
    stackName,
    quickstart: quick,
  });
  
  if (!result) {
    process.exit(1);
  }
  
  // Save state for future upgrades
  const state: DeployState = {
    stackName: result.stackName,
    options: {
      withWhatsApp: result.channels.whatsapp,
      withDiscord: result.channels.discord,
      withTelegram: result.channels.telegram,
      withTemplates: result.deployTemplates,
      withUI: result.deployUI,
    },
    secrets: {
      discordBotToken: result.channels.discordBotToken,
      telegramBotToken: result.channels.telegramBotToken,
    },
    llm: {
      provider: result.llm.provider,
      model: result.llm.model,
    },
    urls: {
      gateway: result.deployment?.gatewayUrl,
      whatsapp: result.deployment?.whatsappUrl,
      discord: result.deployment?.discordUrl,
      telegram: result.deployment?.telegramUrl,
    },
    deployedAt: new Date().toISOString(),
  };
  
  saveDeployState(state);
}

async function commandUp(stackName: string): Promise<void> {
  const state = loadDeployState(stackName);
  
  if (!state) {
    console.log(pc.yellow("No existing deployment found. Running wizard..."));
    console.log("");
    await commandWizard(stackName, false);
    return;
  }
  
  console.log(pc.cyan("\n   ██████╗ ███████╗██╗   ██╗"));
  console.log(pc.cyan("  ██╔════╝ ██╔════╝██║   ██║"));
  console.log(pc.cyan("  ██║  ███╗███████╗██║   ██║"));
  console.log(pc.cyan("  ██║   ██║╚════██║╚██╗ ██╔╝"));
  console.log(pc.cyan("  ╚██████╔╝███████║ ╚████╔╝"));
  console.log(pc.cyan("   ╚═════╝ ╚══════╝  ╚═══╝\n"));
  
  console.log(pc.bold("Re-deploying GSV Infrastructure\n"));
  console.log(`  Stack:      ${state.stackName}`);
  console.log(`  WhatsApp:   ${state.options.withWhatsApp ? "yes" : "no"}`);
  console.log(`  Discord:    ${state.options.withDiscord ? "yes" : "no"}`);
  console.log(`  Telegram:   ${state.options.withTelegram ? "yes" : "no"}`);
  console.log(`  Web UI:     ${state.options.withUI ? "yes" : "no"}`);
  console.log(`  Templates:  ${state.options.withTemplates ? "yes" : "no"}`);
  if (state.deployedAt) {
    console.log(`  Last deploy: ${new Date(state.deployedAt).toLocaleString()}`);
  }
  console.log("");
  
  const p = createCliPrompter();
  const spinner = p.spinner("Deploying...");
  
  try {
    const app = await alchemy(state.stackName, {
      phase: "up",
      quiet: true,
    });
    
    const infra = await createGsvInfra({
      name: state.stackName,
      url: true,
      withWhatsApp: state.options.withWhatsApp,
      withDiscord: state.options.withDiscord,
      withTelegram: state.options.withTelegram,
      withTemplates: state.options.withTemplates,
      withUI: state.options.withUI,
      secrets: {
        discordBotToken: state.secrets?.discordBotToken,
        telegramBotToken: state.secrets?.telegramBotToken,
      },
    });
    
    await app.finalize();
    
    // Update state with new URLs
    state.urls = {
      gateway: await infra.gateway.url,
      whatsapp: infra.whatsappChannel ? await infra.whatsappChannel.url : undefined,
      discord: infra.discordChannel ? await infra.discordChannel.url : undefined,
      telegram: infra.telegramChannel ? await infra.telegramChannel.url : undefined,
    };
    state.deployedAt = new Date().toISOString();
    saveDeployState(state);
    
    spinner.stop(pc.green("Deployed successfully!"));
    
    console.log("");
    console.log(`  Gateway:  ${state.urls.gateway}`);
    if (state.options.withUI) {
      console.log(`  Web UI:   ${state.urls.gateway}`);
    }
    if (state.urls.whatsapp) {
      console.log(`  WhatsApp: ${state.urls.whatsapp}`);
    }
    if (state.urls.discord) {
      console.log(`  Discord:  ${state.urls.discord}`);
    }
    if (state.urls.telegram) {
      console.log(`  Telegram: ${state.urls.telegram}`);
    }
    console.log("");
    
  } catch (error) {
    spinner.stop(pc.red("Deployment failed"));
    console.error(error);
    process.exit(1);
  }
}

async function commandDestroy(stackName: string): Promise<void> {
  const state = loadDeployState(stackName);
  
  console.log(pc.red("\n🗑️  Destroy GSV Deployment\n"));
  
  if (!state) {
    console.log(pc.yellow("No deployment state found for this stack."));
    console.log("If resources exist, you may need to delete them manually.");
    process.exit(1);
  }
  
  console.log(`  Stack:      ${state.stackName}`);
  console.log(`  Gateway:    ${state.urls?.gateway || "unknown"}`);
  if (state.urls?.whatsapp) {
    console.log(`  WhatsApp:   ${state.urls.whatsapp}`);
  }
  if (state.urls?.discord) {
    console.log(`  Discord:    ${state.urls.discord}`);
  }
  if (state.urls?.telegram) {
    console.log(`  Telegram:   ${state.urls.telegram}`);
  }
  console.log("");
  
  const p = createCliPrompter();
  
  // Confirm destruction
  const confirm = await p.confirm({
    message: pc.red("Are you sure you want to destroy ALL resources?"),
    initialValue: false,
  });
  
  if (isCancelled(confirm) || !confirm) {
    console.log("\nDestroy cancelled.");
    process.exit(0);
  }
  
  // Note: alchemy's destroy phase calls process.exit(0) internally,
  // so we can't use a spinner (it would show "Canceled" on exit).
  // Instead, just print a message and let alchemy handle the output.
  console.log(pc.dim("  Destroying resources...\n"));
  
  try {
    const app = await alchemy(state.stackName, {
      phase: "destroy",
      quiet: false, // Let alchemy show progress since we can't
    });
    
    // Need to "create" resources so alchemy knows what to destroy
    await createGsvInfra({
      name: state.stackName,
      url: true,
      withWhatsApp: state.options.withWhatsApp,
      withDiscord: state.options.withDiscord,
      withTelegram: state.options.withTelegram,
      withTemplates: state.options.withTemplates,
      withUI: state.options.withUI,
    });
    
    await app.finalize();
    
    // Note: This code is never reached - alchemy exits in destroy phase
    console.log(pc.green("\nResources destroyed!"));
    console.log("");
    console.log(pc.dim("Note: Deploy state has been kept. Run 'wizard' to deploy fresh."));
    console.log("");
    
  } catch (error) {
    console.error(pc.red("Destroy failed"));
    console.error(error);
    process.exit(1);
  }
}

async function commandStatus(stackName: string): Promise<void> {
  const state = loadDeployState(stackName);
  
  console.log(pc.bold("\nGSV Deployment Status\n"));
  
  if (!state) {
    console.log(pc.yellow("No deployment found."));
    console.log("Run 'bun alchemy/cli.ts' to deploy.\n");
    return;
  }
  
  console.log(`  Stack:       ${state.stackName}`);
  console.log(`  Last deploy: ${state.deployedAt ? new Date(state.deployedAt).toLocaleString() : "unknown"}`);
  console.log("");
  console.log(pc.bold("  URLs:"));
  console.log(`    Gateway:  ${state.urls?.gateway || "not deployed"}`);
  if (state.options.withUI) {
    console.log(`    Web UI:   ${state.urls?.gateway || "not deployed"}`);
  }
  if (state.urls?.whatsapp) {
    console.log(`    WhatsApp: ${state.urls.whatsapp}`);
  }
  if (state.urls?.discord) {
    console.log(`    Discord:  ${state.urls.discord}`);
  }
  if (state.urls?.telegram) {
    console.log(`    Telegram: ${state.urls.telegram}`);
  }
  console.log("");
  console.log(pc.bold("  Options:"));
  console.log(`    WhatsApp channel: ${state.options.withWhatsApp ? "yes" : "no"}`);
  console.log(`    Discord channel:  ${state.options.withDiscord ? "yes" : "no"}`);
  console.log(`    Telegram channel: ${state.options.withTelegram ? "yes" : "no"}`);
  console.log(`    Web UI:           ${state.options.withUI ? "yes" : "no"}`);
  console.log(`    Templates:        ${state.options.withTemplates ? "yes" : "no"}`);
  if (state.llm) {
    console.log("");
    console.log(pc.bold("  LLM:"));
    console.log(`    Provider: ${state.llm.provider}`);
    console.log(`    Model:    ${state.llm.model}`);
  }
  console.log("");
}

// ============================================================================
// Help
// ============================================================================

function printHelp(): void {
  console.log(`
${pc.cyan("GSV Deployment CLI")}

Deploy, upgrade, and manage GSV infrastructure on Cloudflare.

${pc.bold("Usage:")}
  bun alchemy/cli.ts [command] [options]

${pc.bold("Commands:")}
  ${pc.cyan("(default)")}    Run wizard (first time) or re-deploy (after)
  ${pc.cyan("wizard")}       Force interactive setup wizard
  ${pc.cyan("up")}           Re-deploy with saved configuration
  ${pc.cyan("destroy")}      Tear down all resources
  ${pc.cyan("status")}       Show deployment status

${pc.bold("Options:")}
  --name <name>   Stack name (default: gsv)
  --quick, -q     QuickStart mode for wizard
  --help, -h      Show this help

${pc.bold("Examples:")}
  ${pc.dim("# First time deployment (interactive)")}
  bun alchemy/cli.ts

  ${pc.dim("# Re-deploy after making code changes")}
  bun alchemy/cli.ts up

  ${pc.dim("# Quick setup with sensible defaults")}
  bun alchemy/cli.ts wizard --quick

  ${pc.dim("# Destroy everything")}
  bun alchemy/cli.ts destroy

  ${pc.dim("# Check deployment status")}
  bun alchemy/cli.ts status

${pc.bold("Environment Variables:")}
  DISCORD_BOT_TOKEN   Discord bot token
  TELEGRAM_BOT_TOKEN  Telegram bot token
  ANTHROPIC_API_KEY   Anthropic API key

${pc.bold("Discord Bot Requirements:")}
  Enable privileged intent: MESSAGE CONTENT INTENT
  Bot permissions: View Channels, Send Messages, Attach Files, Read Message History
  Invite URL:
  https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=${DISCORD_INVITE_PERMISSIONS}&scope=bot
`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  let command: string | null = null;
  let stackName = "gsv";
  let quick = false;
  
  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
        
      case "--name":
        stackName = args[++i];
        if (!stackName) {
          console.error(pc.red("Error: --name requires a value"));
          process.exit(1);
        }
        break;
        
      case "--quick":
      case "-q":
        quick = true;
        break;
        
      case "wizard":
      case "up":
      case "destroy":
      case "status":
        command = arg;
        break;
        
      default:
        if (arg.startsWith("-")) {
          console.error(pc.red(`Unknown option: ${arg}`));
          console.log("Run with --help for usage.\n");
          process.exit(1);
        } else {
          console.error(pc.red(`Unknown command: ${arg}`));
          console.log("Run with --help for usage.\n");
          process.exit(1);
        }
    }
  }
  
  // Default command: wizard if no state, up if state exists
  if (!command) {
    const state = loadDeployState(stackName);
    command = state ? "up" : "wizard";
  }
  
  // Execute command
  switch (command) {
    case "wizard":
      await commandWizard(stackName, quick);
      break;
      
    case "up":
      await commandUp(stackName);
      break;
      
    case "destroy":
      await commandDestroy(stackName);
      break;
      
    case "status":
      await commandStatus(stackName);
      break;
  }
}

main().catch((error) => {
  console.error(pc.red("Error:"), error);
  process.exit(1);
});
