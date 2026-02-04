/**
 * Deployment Step
 * 
 * Deploys GSV infrastructure using Alchemy.
 */

import type { Prompter } from "../prompter";
import type { WizardState } from "../types";
import { createGsvInfra } from "../../infra";
import alchemy from "alchemy";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DeploymentResult {
  success: boolean;
  gatewayUrl?: string;
  whatsappUrl?: string;
  discordUrl?: string;
  error?: string;
}

/**
 * Check if Alchemy state exists
 */
export function hasAlchemyState(): boolean {
  const stateDir = join(process.cwd(), ".alchemy");
  return existsSync(stateDir);
}

/**
 * Set Alchemy encryption password
 */
export function setAlchemyPassword(password: string): void {
  process.env.ALCHEMY_PASSWORD = password;
}

/**
 * Get Alchemy password from env or throw if needed
 */
function getAlchemyPassword(): string {
  if (!process.env.ALCHEMY_PASSWORD) {
    throw new Error("ALCHEMY_PASSWORD not set - call setAlchemyPassword first");
  }
  return process.env.ALCHEMY_PASSWORD;
}

export async function deployStep(
  p: Prompter,
  state: WizardState
): Promise<DeploymentResult> {
  const spinner = p.spinner("Initializing Alchemy...");

  try {
    // Get password (should have been set by handleAlchemyPassword in wizard)
    const alchemyPassword = getAlchemyPassword();
    
    // Initialize Alchemy app
    const app = await alchemy(state.stackName, {
      stage: process.env.USER || "default",
      phase: process.argv.includes("--destroy") ? "destroy" : "up",
      quiet: true,  // Suppress Alchemy's own output
      password: alchemyPassword,
    });

    spinner.message("Deploying infrastructure...");

    // Deploy infrastructure - this creates all resources
    const infra = await createGsvInfra({
      name: state.stackName,
      url: true,  // Enable public URL for testing
      withWhatsApp: state.channels.whatsapp,
      withDiscord: state.channels.discord,
      withTemplates: state.deployTemplates,
      withUI: state.deployUI,
      secrets: {
        authToken: state.authToken,
        discordBotToken: state.channels.discordBotToken,
      },
    });

    spinner.message("Finalizing deployment...");
    
    // Get URLs (these are available after infra is created)
    const gatewayUrl = await infra.gateway.url;
    const whatsappUrl = infra.whatsappChannel ? await infra.whatsappChannel.url : undefined;
    const discordUrl = infra.discordChannel ? await infra.discordChannel.url : undefined;

    // Finalize Alchemy
    await app.finalize();

    spinner.stop(pc.green("Deployment complete!"));

    return {
      success: true,
      gatewayUrl,
      whatsappUrl,
      discordUrl,
    };
  } catch (error) {
    spinner.stop(pc.red("Deployment failed"));
    
    const message = error instanceof Error ? error.message : String(error);
    p.error(message);

    return {
      success: false,
      error: message,
    };
  }
}
