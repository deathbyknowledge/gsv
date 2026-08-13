import type {
  InstallationDirectoryService,
  ManagedMailGatewayService,
  ManagedMailSummaryService,
} from "@humansandmachines/gsv/protocol";
import type { MailInstallation } from "./mail-installation";

export type MailEnv = Omit<
  Env,
  | "MAIL_DOMAIN"
  | "GSV_BASE_DOMAIN"
  | "MAIL_MAX_MESSAGE_BYTES"
  | "MAIL_DAILY_INBOUND_MESSAGE_LIMIT"
  | "MAIL_DAILY_INBOUND_BYTE_LIMIT"
  | "MAIL_DAILY_SUMMARIZATION_LIMIT"
  | "MAIL_INSTALLATIONS"
  | "ACCOUNTS"
  | "GATEWAY"
  | "INFERENCE"
> & {
  MAIL_DOMAIN: string;
  GSV_BASE_DOMAIN: string;
  MAIL_MAX_MESSAGE_BYTES: number | string;
  MAIL_DAILY_INBOUND_MESSAGE_LIMIT: number | string;
  MAIL_DAILY_INBOUND_BYTE_LIMIT: number | string;
  MAIL_DAILY_SUMMARIZATION_LIMIT: number | string;
  MAIL_INSTALLATIONS: DurableObjectNamespace<MailInstallation>;
  ACCOUNTS: InstallationDirectoryService;
  GATEWAY: ManagedMailGatewayService;
  INFERENCE: ManagedMailSummaryService;
};

export type MailLimits = {
  maxMessageBytes: number;
  dailyInboundMessages: number;
  dailyInboundBytes: number;
  dailySummarizations: number;
};

export function mailLimits(env: MailEnv): MailLimits {
  return {
    maxMessageBytes: positiveInteger(
      env.MAIL_MAX_MESSAGE_BYTES,
      "MAIL_MAX_MESSAGE_BYTES",
    ),
    dailyInboundMessages: positiveInteger(
      env.MAIL_DAILY_INBOUND_MESSAGE_LIMIT,
      "MAIL_DAILY_INBOUND_MESSAGE_LIMIT",
    ),
    dailyInboundBytes: positiveInteger(
      env.MAIL_DAILY_INBOUND_BYTE_LIMIT,
      "MAIL_DAILY_INBOUND_BYTE_LIMIT",
    ),
    dailySummarizations: nonNegativeInteger(
      env.MAIL_DAILY_SUMMARIZATION_LIMIT,
      "MAIL_DAILY_SUMMARIZATION_LIMIT",
    ),
  };
}

function positiveInteger(value: number | string, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed === 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}
