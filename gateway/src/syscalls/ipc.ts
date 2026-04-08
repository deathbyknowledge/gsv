import type { ChannelPeer, ChannelMedia } from "../channel-interface";

export type IpcSendArgs = {
  channel: string;
  to: string;
  text: string;
  peerKind?: ChannelPeer["kind"];
  accountId?: string;
  replyToId?: string;
  media?: ChannelMedia[];
};

export type IpcSendResult =
  | {
      ok: true;
      channel: string;
      to: string;
      messageId?: string;
    }
  | { ok: false; error: string };

export type ChannelStatus = {
  channel: string;
  accounts: ChannelAccountInfo[];
};

export type ChannelAccountInfo = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  lastActivity?: number;
  error?: string;
};
