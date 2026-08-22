import { z } from "zod";

export const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";

export type TargetChatProcess = {
  pid: string;
};

const targetChatProcessInputSchema = z.object({
  pid: z.string().optional(),
  processId: z.string().optional(),
});
type TargetChatProcessInput = z.input<typeof targetChatProcessInputSchema>;

export function normalizeTargetChatProcess(value: TargetChatProcessInput): TargetChatProcess | null {
  const parsed = targetChatProcessInputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const pid = parsed.data.pid?.trim() || parsed.data.processId?.trim() || "";
  if (!pid) {
    return null;
  }
  return { pid };
}

export function dispatchTargetChatProcess(target: TargetChatProcess): void {
  const browserWindow = globalThis.window;
  if (!browserWindow) {
    return;
  }
  browserWindow.dispatchEvent(new CustomEvent(TARGET_CHAT_PROCESS_EVENT, { detail: target }));
}
