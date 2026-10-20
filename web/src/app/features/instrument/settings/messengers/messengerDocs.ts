// External documentation per adapter (GSV docs site).
import { publicDeployment } from "../../../../services/deployment";
import type { TextKey } from "../../../../i18n/locale";
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
  title: TextKey;
  detail: TextKey;
}

export const MESSENGER_CAPABILITIES: MessengerCapability[] = [
  {
    title: "settings.pairing.capability.files",
    detail: "settings.pairing.capability.filesDetail",
  },
  {
    title: "settings.pairing.capability.approve",
    detail: "settings.pairing.capability.approveDetail",
  },
  {
    title: "settings.pairing.capability.message",
    detail: "settings.pairing.capability.messageDetail",
  },
  {
    title: "settings.pairing.capability.control",
    detail: "settings.pairing.capability.controlDetail",
  },
];
