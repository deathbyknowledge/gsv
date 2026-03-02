/**
 * Channel Selection Step
 */

import type { Prompter } from "../prompter";
import type { WizardMode, ChannelConfig } from "../types";
import { isCancelled, handleCancel } from "../prompter";
import pc from "picocolors";

type ChannelId = "whatsapp" | "discord" | "telegram";
const DISCORD_INVITE_PERMISSIONS = 101376; // View Channels + Send Messages + Attach Files + Read Message History

export async function channelsStep(
  p: Prompter,
  mode: WizardMode
): Promise<ChannelConfig> {
  p.note(
    `Channels allow you to interact with GSV through messaging apps.\n\n` +
    `${pc.bold("WhatsApp")} - Chat via WhatsApp (requires QR code login)\n` +
    `${pc.bold("Discord")}  - Add a bot to your Discord server\n\n` +
    `${pc.dim("You can add more channels later.")}`,
    "Channels"
  );

  const channels = await p.multiselect<ChannelId>({
    message: "Which channels do you want to enable?",
    options: [
      {
        value: "whatsapp",
        label: "WhatsApp",
        hint: "Personal or business number",
      },
      {
        value: "discord",
        label: "Discord",
        hint: "Requires bot token",
      },
      {
        value: "telegram",
        label: "Telegram",
        hint: "Requires bot token",
      },
    ],
    required: false,
  });

  if (isCancelled(channels)) {
    handleCancel();
  }

  const config: ChannelConfig = {
    whatsapp: channels.includes("whatsapp"),
    discord: channels.includes("discord"),
    telegram: channels.includes("telegram"),
  };

  // Get Discord bot token if selected
  if (config.discord) {
    p.note(
      `${pc.bold("1. Create Application")}\n` +
      `   Go to ${pc.cyan("https://discord.com/developers/applications")}\n` +
      `   Click "New Application" and give it a name\n\n` +
      `${pc.bold("2. Create Bot & Get Token")}\n` +
      `   Go to "Bot" tab → "Add Bot"\n` +
      `   Click "Reset Token" and copy it\n\n` +
      `${pc.bold("3. Enable Required Intents")} ${pc.yellow("(Important!)")}\n` +
      `   In the Bot tab, scroll to "Privileged Gateway Intents"\n` +
      `   Enable: ${pc.cyan("MESSAGE CONTENT INTENT")}\n` +
      `   (Required to read message text)\n\n` +
      `${pc.bold("4. Invite Bot to Server")}\n` +
      `   Go to "OAuth2" → "URL Generator"\n` +
      `   Scopes: ${pc.cyan("bot")}\n` +
      `   Permissions: ${pc.cyan("View Channels, Send Messages, Attach Files, Read Message History")}\n` +
      `   Or use: ${pc.cyan(`https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=${DISCORD_INVITE_PERMISSIONS}&scope=bot`)}\n` +
      `   Copy URL and open in browser to invite`,
      "Discord Bot Setup"
    );

    const token = await p.password({
      message: "Enter your Discord bot token",
      validate: (value) => {
        if (!value) {
          return "Bot token is required for Discord";
        }
        // Discord tokens are base64-ish
        if (value.length < 50) {
          return "Token seems too short";
        }
      },
    });

    if (isCancelled(token)) {
      handleCancel();
    }

    config.discordBotToken = token;
  }

  if (config.telegram) {
    p.note(
      `${pc.bold("1. Create Telegram Bot")}\n` +
      `   Open Telegram and chat with ${pc.cyan("@BotFather")}\n` +
      `   Run ${pc.cyan("/newbot")} and follow prompts\n` +
      `   Copy the bot token BotFather returns\n\n` +
      `${pc.bold("2. Webhook Setup")}\n` +
      `   GSV will configure the webhook endpoint automatically on deploy`,
      "Telegram Bot Setup",
    );

    const token = await p.password({
      message: "Enter your Telegram bot token",
      validate: (value) => {
        if (!value) {
          return "Bot token is required for Telegram";
        }
        if (!value.includes(":")) {
          return "Token format should look like <id>:<secret>";
        }
      },
    });

    if (isCancelled(token)) {
      handleCancel();
    }

    config.telegramBotToken = token;
  }

  return config;
}
