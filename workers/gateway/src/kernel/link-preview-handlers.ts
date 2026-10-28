import type {
  BinaryBody,
  ConversationLinkImageArgs,
  ConversationLinkImageResult,
  ConversationLinkPreviewArgs,
  ConversationLinkPreviewResult,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";
import { raceWithAbort } from "../shared/abort";
import type { KernelContext } from "./context";
import { requireConversationClient } from "./conversation-handlers";

const linkPreviewArgsSchema = z.object({ url: z.string() });
const linkImageArgsSchema = z.object({ key: z.string() });

export async function handleConversationLinkPreview(
  args: ConversationLinkPreviewArgs,
  ctx: KernelContext,
): Promise<ConversationLinkPreviewResult> {
  requireConversationClient(ctx);
  const { url } = linkPreviewArgsSchema.parse(args);
  // The fetch is shared by every caller of the same URL, so one caller's cancellation only stops its own wait.
  return raceWithAbort(ctx.linkPreviews.preview(url), ctx.requestSignal);
}

export async function handleConversationLinkImage(
  args: ConversationLinkImageArgs,
  ctx: KernelContext,
): Promise<{ data: ConversationLinkImageResult; body?: BinaryBody }> {
  requireConversationClient(ctx);
  return ctx.linkPreviews.image(linkImageArgsSchema.parse(args).key);
}
