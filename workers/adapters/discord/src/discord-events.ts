import { z } from "zod";

const discordAuthorSchema = z.object({
  id: z.string(), username: z.string(), bot: z.boolean().optional(), discriminator: z.string().optional(),
}).passthrough();
export const discordAttachmentPayloadSchema = z.object({
  id: z.string(), filename: z.string(), url: z.string().optional(), proxy_url: z.string().optional(),
  size: z.number().optional(), content_type: z.string().optional(), duration_secs: z.number().optional(),
}).passthrough();
export const discordMessagePayloadSchema = z.object({
  id: z.string(), author: discordAuthorSchema.optional(), content: z.string().optional(),
  guild_id: z.string().optional(), channel_id: z.string(), timestamp: z.string().optional(),
  attachments: z.array(discordAttachmentPayloadSchema).optional(), mentions: z.array(z.object({ id: z.string().optional() })).optional(),
  message_reference: z.object({ message_id: z.string().optional() }).optional(),
  referenced_message: z.object({ author: z.object({ id: z.string().optional() }).optional() }).nullable().optional(),
}).passthrough();
export const discordGatewayFrameSchema = z.object({
  op: z.number().int(), t: z.string().nullish(), d: z.json().optional(), s: z.number().int().nullish(),
});
export const discordHelloSchema = z.object({ heartbeat_interval: z.number().positive() });
export const discordReadyPayloadSchema = z.object({
  session_id: z.string(), resume_gateway_url: z.string(),
  application: z.object({ id: z.string() }).optional(),
  user: z.object({ id: z.string(), username: z.string() }).optional(),
});
export const discordGuildSchema = z.object({ id: z.string(), name: z.string().optional(), unavailable: z.boolean().optional() });
export type DiscordMessagePayload = z.infer<typeof discordMessagePayloadSchema>;
export type DiscordDispatchPayload = z.infer<typeof discordGatewayFrameSchema>["d"];
export type DiscordGatewayFrame = z.infer<typeof discordGatewayFrameSchema>;

export function parseDiscordGatewayFrame(raw: string): DiscordGatewayFrame {
  return discordGatewayFrameSchema.parse(JSON.parse(raw));
}
