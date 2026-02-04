/**
 * GSV Deployment Wizard
 * 
 * Interactive setup wizard for deploying GSV infrastructure.
 */

import { createCliPrompter, isCancelled, handleCancel } from "./prompter";
import type { WizardState } from "./types";
import { DEFAULT_STATE } from "./types";
import { securityStep } from "./steps/security";
import { modeStep } from "./steps/mode";
import { authStep } from "./steps/auth";
import { providerStep } from "./steps/provider";
import { channelsStep } from "./steps/channels";
import { deployStep, hasAlchemyState, setAlchemyPassword } from "./steps/deploy";
import { channelSetupStep } from "./steps/channel-setup";
import { saveCliConfig } from "./steps/cli-config";
import { configureGateway } from "./steps/gateway-config";
import { installCliStep } from "./steps/cli-install";
import pc from "picocolors";

const VERSION = "0.1.0";

const BANNER = `
   ██████╗ ███████╗██╗   ██╗
  ██╔════╝ ██╔════╝██║   ██║
  ██║  ███╗███████╗██║   ██║
  ██║   ██║╚════██║╚██╗ ██╔╝
  ╚██████╔╝███████║ ╚████╔╝
   ╚═════╝ ╚══════╝  ╚═══╝
`;

export interface WizardOptions {
  /** Skip security acknowledgment */
  skipSecurity?: boolean;
  /** Force quickstart mode */
  quickstart?: boolean;
  /** Stack name override */
  stackName?: string;
  /** Skip CLI installation */
  skipCli?: boolean;
  /** Skip channel setup */
  skipChannelSetup?: boolean;
}

export async function runWizard(options: WizardOptions = {}): Promise<WizardState | null> {
  const p = createCliPrompter();
  
  // Display banner
  console.log(pc.cyan(BANNER));
  p.intro(`GSV Deployment Wizard v${VERSION}`);

  // Initialize state
  const state: WizardState = { ...DEFAULT_STATE };
  
  if (options.stackName) {
    state.stackName = options.stackName;
  }

  // Step 1: Security acknowledgment
  if (!options.skipSecurity) {
    const accepted = await securityStep(p);
    if (!accepted) {
      p.outro("Setup cancelled. Read the security docs and come back when ready!");
      return null;
    }
  }

  // Step 2: Mode selection
  if (options.quickstart) {
    state.mode = "quickstart";
    p.log(`Mode: ${pc.cyan("QuickStart")}`);
  } else {
    state.mode = await modeStep(p);
  }

  // Step 3: Auth token
  state.authToken = await authStep(p, state.mode);

  // Step 4: LLM provider
  state.llm = await providerStep(p, state.mode);

  // Step 5: Channels
  state.channels = await channelsStep(p, state.mode);

  // Step 6: Advanced options (only in advanced mode)
  if (state.mode === "advanced") {
    const deployTemplates = await p.confirm({
      message: "Deploy workspace templates (SOUL.md, etc.)?",
      initialValue: true,
    });
    
    if (isCancelled(deployTemplates)) {
      handleCancel();
    }
    
    state.deployTemplates = deployTemplates;

    // Web UI
    const deployUI = await p.confirm({
      message: "Deploy web UI?",
      initialValue: true,
    });
    
    if (isCancelled(deployUI)) {
      handleCancel();
    }
    
    state.deployUI = deployUI;

    // Stack name
    const stackName = await p.text({
      message: "Deployment name",
      initialValue: state.stackName,
      validate: (value) => {
        if (!value) return "Name is required";
        if (!/^[a-z0-9-]+$/.test(value)) {
          return "Only lowercase letters, numbers, and hyphens allowed";
        }
      },
    });

    if (isCancelled(stackName)) {
      handleCancel();
    }

    state.stackName = stackName;
  }

  // Confirmation
  p.note(
    `${pc.bold("Stack:")}    ${state.stackName}\n` +
    `${pc.bold("Provider:")} ${state.llm.provider} (${state.llm.model})\n` +
    `${pc.bold("Channels:")} ${[
      state.channels.whatsapp && "WhatsApp",
      state.channels.discord && "Discord",
    ].filter(Boolean).join(", ") || "None"}\n` +
    `${pc.bold("Web UI:")}   ${state.deployUI ? "Yes" : "No"}\n` +
    `${pc.bold("Templates:")} ${state.deployTemplates ? "Yes" : "No"}`,
    "Configuration Summary"
  );

  const proceed = await p.confirm({
    message: "Ready to deploy?",
    initialValue: true,
  });

  if (isCancelled(proceed) || !proceed) {
    p.outro("Deployment cancelled.");
    return null;
  }

  // Handle Alchemy password before deployment
  if (process.env.ALCHEMY_PASSWORD) {
    p.log(`Using ALCHEMY_PASSWORD from environment`);
    setAlchemyPassword(process.env.ALCHEMY_PASSWORD);
  } else {
    const isUpdate = hasAlchemyState();
    
    const password = await p.password({
      message: isUpdate 
        ? "Enter your Alchemy password (same as original deployment)"
        : "Choose an Alchemy password (for future updates)",
      validate: (value) => {
        if (!value || value.length < 8) {
          return "Password must be at least 8 characters";
        }
      },
    });
    
    if (isCancelled(password)) {
      handleCancel();
    }
    
    setAlchemyPassword(password);
    
    if (!isUpdate) {
      p.log(`${pc.dim("Tip: Set ALCHEMY_PASSWORD env var to skip this prompt")}`);
    }
  }

  // Step 7: Deploy
  const deployment = await deployStep(p, state);
  
  if (!deployment.success) {
    p.outro(pc.red("Deployment failed. Check the errors above."));
    return null;
  }

  state.deployment = {
    gatewayUrl: deployment.gatewayUrl,
    whatsappUrl: deployment.whatsappUrl,
    discordUrl: deployment.discordUrl,
  };

  // Step 8: Configure Gateway via WebSocket
  const configSuccess = await configureGateway(p, state);
  
  // Step 9: Install CLI
  const cliResult = await installCliStep(p);

  // Step 10: Save CLI config (always, so gsv commands work)
  await saveCliConfig(p, state);

  // Step 11: Show channel setup instructions
  if (state.channels.whatsapp || state.channels.discord) {
    await channelSetupStep(p, state);
  }

  // Final summary
  const nextSteps: string[] = [
    `${pc.cyan("gsv client")} - Start chatting`,
    `${pc.cyan("gsv node --id mypc")} - Connect a tool node`,
  ];
  
  if (state.channels.whatsapp) {
    nextSteps.push(`${pc.cyan("gsv channel whatsapp login")} - Connect WhatsApp`);
  }
  if (state.channels.discord) {
    nextSteps.push(`${pc.cyan("gsv channel discord start")} - Start Discord bot`);
  }

  // Build status lines
  const statusLines = [
    `${pc.bold("Gateway URL:")} ${state.deployment.gatewayUrl}`,
    state.deployUI ? `${pc.bold("Web UI:")}     ${state.deployment.gatewayUrl}` : null,
    state.deployment.whatsappUrl ? `${pc.bold("WhatsApp:")}   ${state.deployment.whatsappUrl}` : null,
    state.deployment.discordUrl ? `${pc.bold("Discord:")}    ${state.deployment.discordUrl}` : null,
    ``,
    `${pc.bold("LLM:")} ${configSuccess ? pc.green("Configured") : pc.yellow("Manual config needed")}`,
    `${pc.bold("CLI:")} ${cliResult.installed ? pc.green("Installed") : pc.yellow("Manual install needed")}`,
  ].filter(Boolean);

  // Add manual instructions if needed
  if (!configSuccess) {
    statusLines.push(
      ``,
      `${pc.bold("Run to configure LLM:")}`,
      `  gsv config set model.provider ${state.llm.provider}`,
      `  gsv config set model.id ${state.llm.model}`,
      `  gsv config set apiKeys.${state.llm.provider} <your-key>`,
    );
  }

  if (!cliResult.installed) {
    statusLines.push(
      ``,
      `${pc.bold("Run to install CLI:")}`,
      `  cargo install --path cli`,
    );
  }

  statusLines.push(
    ``,
    `${pc.bold("Next steps:")}`,
    ...nextSteps.map(s => `  ${s}`),
  );

  p.note(statusLines.join("\n"), "Deployment Complete!");

  if (configSuccess && cliResult.installed) {
    p.outro(pc.green("GSV deployed and ready! Run 'gsv client' to start chatting."));
  } else {
    p.outro(pc.green("GSV deployed! Complete the manual steps above to finish setup."));
  }

  return state;
}
