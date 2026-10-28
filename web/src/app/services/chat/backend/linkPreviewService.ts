import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ConversationLinkPreview } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { t } from "../../../i18n/locale";
import { frameBodyToBlob } from "../../gateway/frameBody";
import { MAX_CHAT_PROCESS_MEDIA_BYTES } from "../domain/processes";

type LinkPreviewGsvClient = Pick<GSVClient, "call" | "request">;

const linkPreviewResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    preview: z.object({
      url: z.string(),
      resolvedUrl: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      siteName: z.string().optional(),
      image: z.object({
        key: z.string(),
        mimeType: z.string(),
        size: z.number().int().nonnegative(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional(),
    }),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const linkImageDataSchema = z.union([
  z.object({ ok: z.literal(true), key: z.string(), mimeType: z.string(), size: z.number().int().nonnegative() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** The Kernel reads the page on the signed-in client's behalf; the browser never contacts the linked site. */
export async function fetchLinkPreview(client: LinkPreviewGsvClient, url: string): Promise<ConversationLinkPreview> {
  const result = linkPreviewResultSchema.parse(await client.call("conversation.link.preview", { url }));
  if (!result.ok) throw new Error(result.error || t("chat.request.failed"));
  return result.preview;
}

/** The preview image arrives through the Kernel as a frame body, never from the third-party image URL. */
export async function fetchLinkPreviewImage(client: LinkPreviewGsvClient, key: string): Promise<Blob> {
  const response = await client.request("conversation.link.image", { key });
  const data = linkImageDataSchema.parse(response.data);
  if (!data.ok) {
    await response.body?.stream.cancel(data.error).catch(() => {});
    throw new Error(data.error || t("chat.media.requestFailed"));
  }
  if (data.size > MAX_CHAT_PROCESS_MEDIA_BYTES) {
    // The cancellation reason travels to the gateway, so it stays in English; the person reads the thrown message.
    await response.body?.stream.cancel("Link preview image exceeds the 25 MiB display limit").catch(() => {});
    throw new Error(t("chat.media.tooLarge"));
  }
  if (!response.body) throw new Error("Link preview image response did not include a body");
  return await frameBodyToBlob(response.body, {
    mimeType: data.mimeType,
    expectedLength: data.size,
    label: "Link preview image",
  });
}
