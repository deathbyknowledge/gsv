import { MAIL_MAX_MESSAGE_BYTES, MAIL_MAX_OUTBOUND_TEXT_BYTES } from "@humansandmachines/gsv/services/mail";
import * as z from "zod/mini";
import { EntitlementCache } from "@humansandmachines/gsv/services/entitlements";
import { mailLimits, outboundEnabled, type MailEnv, type MailLimits, type MailLimitEnvironment } from "./env";

export class MailPolicy {
  private readonly cache: EntitlementCache | undefined;

  constructor(private readonly env: MailLimitEnvironment & Pick<MailEnv, "ENTITLEMENTS" | "GSV_TELEMETRY_ENABLED">, installationId: string) {
    if (env.ENTITLEMENTS) this.cache = new EntitlementCache(env.ENTITLEMENTS, installationId,
      { env, component: "mail" });
  }

  async limits(): Promise<MailLimits> {
    if (!this.cache) return mailLimits(this.env);
    const { values } = await this.cache.get();
    const enabled = (key: string): boolean => z.boolean().parse(values[key]);
    const limit = (key: string, max = Number.MAX_SAFE_INTEGER): number =>
      z.number().check(z.int(), z.gte(0), z.lte(max)).parse(values[key]);
    return {
      inboundEnabled: enabled("mail.inbound.enabled"),
      outboundEnabled: enabled("mail.outbound.enabled") && outboundEnabled(this.env),
      maxMessageBytes: limit("mail.inbound.max_message_bytes", MAIL_MAX_MESSAGE_BYTES),
      dailyInboundMessages: limit("mail.inbound.daily_messages"),
      dailyInboundBytes: limit("mail.inbound.daily_bytes"),
      dailySummarizations: limit("mail.daily_summarizations"),
      maxOutboundTextBytes: limit("mail.outbound.max_text_bytes", MAIL_MAX_OUTBOUND_TEXT_BYTES),
      dailyOutboundMessages: limit("mail.outbound.daily_messages"),
      dailyOutboundBytes: limit("mail.outbound.daily_bytes"),
    };
  }
}
