/**
 * Channel Setup Step
 * 
 * Shows instructions for completing channel setup via CLI.
 */

import type { Prompter } from "../prompter";
import type { WizardState } from "../types";
import pc from "picocolors";

export interface ChannelSetupResult {
  instructionsShown: boolean;
}

export async function channelSetupStep(
  p: Prompter,
  state: WizardState
): Promise<ChannelSetupResult> {
  if (!state.channels.whatsapp && !state.channels.discord && !state.channels.telegram) {
    return { instructionsShown: false };
  }

  const instructions: string[] = [];

  if (state.channels.whatsapp) {
    instructions.push(
      `${pc.bold("WhatsApp")}`,
      `  Login:  ${pc.cyan("gsv channel whatsapp login")}`,
      `  Status: ${pc.cyan("gsv channel whatsapp status")}`,
      ``
    );
  }

  if (state.channels.discord) {
    instructions.push(
      `${pc.bold("Discord")}`,
      `  Start:  ${pc.cyan("gsv channel discord start")}`,
      `  Status: ${pc.cyan("gsv channel discord status")}`,
      ``
    );
  }

  if (state.channels.telegram) {
    instructions.push(
      `${pc.bold("Telegram")}`,
      `  Start:  ${pc.cyan("gsv channel telegram start")}`,
      `  Status: ${pc.cyan("gsv channel telegram status")}`,
      ``
    );
  }

  p.note(
    `Use the CLI to complete channel setup:\n\n` +
    instructions.join("\n"),
    "Channel Setup"
  );

  return { instructionsShown: true };
}
