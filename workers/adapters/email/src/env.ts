import type {
  ManagedMailSummaryService,
} from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { MailGatewayService } from "@humansandmachines/gsv/services/mail";
import type { MailInstallation } from "./mail-installation";
import type { MailFooter } from "./render";
import type { EntitlementsService } from "@humansandmachines/gsv/services/entitlements";
import type { TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";

export type MailEnv = Omit<
  Env,
  | "ENTITLEMENTS"
  | "MAIL_DOMAIN"
  | "GSV_BASE_DOMAIN"
  | "MAIL_MAX_MESSAGE_BYTES"
  | "MAIL_DAILY_INBOUND_MESSAGE_LIMIT"
  | "MAIL_DAILY_INBOUND_BYTE_LIMIT"
  | "MAIL_DAILY_SUMMARIZATION_LIMIT"
  | "MAIL_OUTBOUND_ENABLED"
  | "MAIL_MAX_OUTBOUND_TEXT_BYTES"
  | "MAIL_DAILY_OUTBOUND_MESSAGE_LIMIT"
  | "MAIL_DAILY_OUTBOUND_BYTE_LIMIT"
  | "MAIL_INSTALLATIONS"
  | "ACCOUNTS"
  | "GATEWAY"
  | "INFERENCE"
  | "EMAIL"
> & {
  MAIL_DOMAIN: string;
  MAIL_SENDING_DOMAINS?: string;
  MAIL_RECEIVING_DOMAINS?: string;
  /** The operator's line under every sent message, e.g. "Sent from my Ship"; none when unset. */
  MAIL_FOOTER_TEXT?: string;
  /** Where the footer links, e.g. "https://ship.space". */
  MAIL_FOOTER_URL?: string;
  GSV_BASE_DOMAIN: string;
  ENTITLEMENTS?: EntitlementsService;
  MAIL_MAX_MESSAGE_BYTES?: number | string;
  MAIL_DAILY_INBOUND_MESSAGE_LIMIT?: number | string;
  MAIL_DAILY_INBOUND_BYTE_LIMIT?: number | string;
  MAIL_DAILY_SUMMARIZATION_LIMIT?: number | string;
  MAIL_OUTBOUND_ENABLED: boolean | number | string;
  MAIL_MAX_OUTBOUND_TEXT_BYTES?: number | string;
  MAIL_DAILY_OUTBOUND_MESSAGE_LIMIT?: number | string;
  MAIL_DAILY_OUTBOUND_BYTE_LIMIT?: number | string;
  MAIL_INSTALLATIONS: DurableObjectNamespace<MailInstallation>;
  ACCOUNTS: InstallationDirectoryService;
  GATEWAY: MailGatewayService;
  INFERENCE: ManagedMailSummaryService;
  EMAIL: SendEmail;
} & TelemetryEnvironment;

export type MailLimits = {
  inboundEnabled: boolean;
  maxMessageBytes: number;
  dailyInboundMessages: number;
  dailyInboundBytes: number;
  dailySummarizations: number;
  outboundEnabled: boolean;
  maxOutboundTextBytes: number;
  dailyOutboundMessages: number;
  dailyOutboundBytes: number;
};

export type MailLimitEnvironment = Pick<MailEnv,
  | "MAIL_MAX_MESSAGE_BYTES" | "MAIL_DAILY_INBOUND_MESSAGE_LIMIT" | "MAIL_DAILY_INBOUND_BYTE_LIMIT"
  | "MAIL_DAILY_SUMMARIZATION_LIMIT" | "MAIL_OUTBOUND_ENABLED" | "MAIL_MAX_OUTBOUND_TEXT_BYTES"
  | "MAIL_DAILY_OUTBOUND_MESSAGE_LIMIT" | "MAIL_DAILY_OUTBOUND_BYTE_LIMIT"
>;

export function mailLimits(env: MailLimitEnvironment): MailLimits {
  return {
    inboundEnabled: true,
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
    outboundEnabled: outboundEnabled(env),
    maxOutboundTextBytes: positiveInteger(
      env.MAIL_MAX_OUTBOUND_TEXT_BYTES,
      "MAIL_MAX_OUTBOUND_TEXT_BYTES",
    ),
    dailyOutboundMessages: nonNegativeInteger(
      env.MAIL_DAILY_OUTBOUND_MESSAGE_LIMIT,
      "MAIL_DAILY_OUTBOUND_MESSAGE_LIMIT",
    ),
    dailyOutboundBytes: nonNegativeInteger(
      env.MAIL_DAILY_OUTBOUND_BYTE_LIMIT,
      "MAIL_DAILY_OUTBOUND_BYTE_LIMIT",
    ),
  };
}

function booleanValue(
  value: boolean | number | string,
  name: string,
): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") {
    return true;
  }
  if (value === false || value === 0 || value === "0" || value === "false") {
    return false;
  }
  throw new Error(`${name} must be a boolean`);
}

export function outboundEnabled(env: Pick<MailEnv, "MAIL_OUTBOUND_ENABLED">): boolean {
  return booleanValue(env.MAIL_OUTBOUND_ENABLED, "MAIL_OUTBOUND_ENABLED");
}

const MAX_FOOTER_TEXT_LENGTH = 200;

/** The operator's footer, or none when the deployment sets no footer text. */
export function mailFooter(env: Pick<MailEnv, "MAIL_FOOTER_TEXT" | "MAIL_FOOTER_URL">): MailFooter | undefined {
  const text = env.MAIL_FOOTER_TEXT?.trim();
  const url = env.MAIL_FOOTER_URL?.trim();
  if (!text) {
    if (url) throw new Error("MAIL_FOOTER_URL requires MAIL_FOOTER_TEXT");
    return undefined;
  }
  if (text.length > MAX_FOOTER_TEXT_LENGTH || /\p{Cc}/u.test(text)) {
    throw new Error("MAIL_FOOTER_TEXT is invalid");
  }
  if (!url) return { text };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MAIL_FOOTER_URL must be an HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("MAIL_FOOTER_URL must be an HTTPS URL");
  }
  return { text, url };
}

function positiveInteger(value: number | string | undefined, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed === 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: number | string | undefined, name: string): number {
  const parsed = Number(value) === value ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}
