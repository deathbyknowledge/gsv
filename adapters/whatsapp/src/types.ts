// WhatsApp account state
export type WhatsAppAccountState = {
  accountId: string;
  selfJid?: string;
  selfE164?: string;
  connected: boolean;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastMessageAt?: number;
};
