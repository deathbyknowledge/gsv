import type {
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterAccountStatus,
  AdapterMedia,
  AdapterSurface,
} from "../adapter-interface";

export type AdapterSendArgs = {
  adapter: string;
  accountId: string;
  surface: AdapterSurface;
  text: string;
  replyToId?: string;
  media?: AdapterMedia[];
};

export type AdapterSendResult =
  | {
      ok: true;
      adapter: string;
      accountId: string;
      surfaceId: string;
      messageId?: string;
    }
  | {
      ok: false;
      error: string;
    };

export type AdapterStatusArgs = {
  adapter: string;
  accountId?: string;
};

export type AdapterStatusResult = {
  adapter: string;
  accounts: AdapterAccountStatus[];
};

export type AdapterInboundArgs = {
  adapter: string;
  accountId: string;
  message: AdapterInboundMessage;
};

export type AdapterInboundSyscallResult = AdapterInboundResult;

export type AdapterStateUpdateArgs = {
  adapter: string;
  accountId: string;
  status: AdapterAccountStatus;
};

export type AdapterStateUpdateResult = {
  ok: true;
};
