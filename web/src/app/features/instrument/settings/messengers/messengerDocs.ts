// External documentation per adapter (GSV docs site).
import { publicDeployment } from "../../../../services/deployment";
// Returns the doc URL for an adapter, falling back to the adapters root.
export function adapterDocUrl(adapter: string): string {
  const docsRoot = publicDeployment().docsUrl;
  const root = docsRoot
    ? new URL("how-to/messengers", docsRoot.endsWith("/") ? docsRoot : `${docsRoot}/`).href
    : "https://github.com/deathbyknowledge/gsv/blob/main/docs/how-to/messengers.md";
  const id = adapter.toLowerCase();
  return ["telegram", "slack", "discord"].includes(id) ? `${root}#${id}` : root;
}

// Telegram BotFather (where users create a bot + get a token).
export const BOTFATHER_URL = "https://t.me/botfather";
// Discord developer portal (where users create a bot application + token).
export const DISCORD_DEVELOPER_URL = "https://discord.com/developers/applications";
// Slack API portal (where standalone users create and configure their app).
export const SLACK_APPS_URL = "https://api.slack.com/apps";

// "Things you can do with your messenger-bot" — shown on the success step.
export interface MessengerCapability {
  title: string;
  detail: string;
}

export const MESSENGER_CAPABILITIES: MessengerCapability[] = [
  {
    title: "Check remote files",
    detail: "Browse and pull files from your Ship from anywhere.",
  },
  {
    title: "Approve tasks remotely",
    detail: "Review and approve pending tasks without opening the console.",
  },
  {
    title: "Message your Ship",
    detail: "Chat with your Ship and get replies straight in the messenger.",
  },
  {
    title: "Stay in control",
    detail: "Run commands and steer your Ship remotely, wherever you are.",
  },
];
