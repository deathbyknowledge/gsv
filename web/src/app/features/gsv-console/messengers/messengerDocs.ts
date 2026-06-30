// External documentation per adapter (GSV docs site).
export const ADAPTER_DOC_URLS: Record<string, string> = {
  telegram: "https://docs.gsv.space/how-to/messengers#telegram",
  discord: "https://docs.gsv.space/how-to/messengers#discord",
};

const ADAPTERS_ROOT_URL = "https://docs.gsv.space/how-to/messengers";

// Returns the doc URL for an adapter, falling back to the adapters root.
export function adapterDocUrl(adapter: string): string {
  return ADAPTER_DOC_URLS[adapter.toLowerCase()] ?? ADAPTERS_ROOT_URL;
}

// Telegram BotFather (where users create a bot + get a token).
export const BOTFATHER_URL = "https://t.me/botfather";
// Discord developer portal (where users create a bot application + token).
export const DISCORD_DEVELOPER_URL = "https://discord.com/developers/applications";

// "Things you can do with your messenger-bot" — shown on the success step.
export interface MessengerCapability {
  title: string;
  detail: string;
}

export const MESSENGER_CAPABILITIES: MessengerCapability[] = [
  {
    title: "Check remote files",
    detail: "Browse and pull files from your GSV from anywhere.",
  },
  {
    title: "Approve tasks remotely",
    detail: "Review and approve pending tasks without opening the console.",
  },
  {
    title: "Message your GSV",
    detail: "Chat with your GSV and get replies straight in the messenger.",
  },
  {
    title: "Stay in control",
    detail: "Run commands and steer your GSV remotely, wherever you are.",
  },
];
