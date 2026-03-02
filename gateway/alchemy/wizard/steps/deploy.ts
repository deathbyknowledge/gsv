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


export interface DeploymentResult {
  success: boolean;
  gatewayUrl?: string;
  whatsappUrl?: string;
  discordUrl?: string;
  telegramUrl?: string;
  error?: string;
}



export async function deployStep(
  p: Prompter,
  state: WizardState
): Promise<DeploymentResult> {
  const spinner = p.spinner("Initializing Alchemy...");

  try {
    // Initialize Alchemy app
    // No password needed - we don't use alchemy.secret() for any values
    const app = await alchemy(state.stackName, {
      stage: process.env.USER || "default",
      phase: process.argv.includes("--destroy") ? "destroy" : "up",
      quiet: true,  // Suppress Alchemy's own output
    });

    spinner.message("Deploying infrastructure...");

    // Deploy infrastructure - this creates all resources
    const infra = await createGsvInfra({
      name: state.stackName,
      url: true,  // Enable public URL for testing
      withWhatsApp: state.channels.whatsapp,
      withDiscord: state.channels.discord,
      withTelegram: state.channels.telegram,
      withTemplates: state.deployTemplates,
      withUI: state.deployUI,
      secrets: {
        discordBotToken: state.channels.discordBotToken,
        telegramBotToken: state.channels.telegramBotToken,
      },
    });

    spinner.message("Finalizing deployment...");
    
    // Get URLs (these are available after infra is created)
    const gatewayUrl = await infra.gateway.url;
    const whatsappUrl = infra.whatsappChannel ? await infra.whatsappChannel.url : undefined;
    const discordUrl = infra.discordChannel ? await infra.discordChannel.url : undefined;
    const telegramUrl = infra.telegramChannel ? await infra.telegramChannel.url : undefined;

    // Finalize Alchemy
    await app.finalize();

    spinner.stop(pc.green("Deployment complete!"));

    return {
      success: true,
      gatewayUrl,
      whatsappUrl,
      discordUrl,
      telegramUrl,
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
