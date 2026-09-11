import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { renderCompactionTranscriptWindow } from "./history/compaction-renderer";

describe("selected target message context", () => {
  it("renders each message's target while deduplicating origins and omitting unselected context", async () => {
    const stub = await initProcess("selected-target-origin", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const web = JSON.stringify({ kind: "client", connectionId: "web", clientId: "gsv-ui", platform: "browser" });
      const telegram = JSON.stringify({ kind: "adapter", adapter: "telegram", accountId: "fixture", actorId: "human", surface: { kind: "dm", id: "fixture-dm" } });
      const input = [
        { text: "Clean up my downloads.", selectedTarget: "macbook", origin: web },
        { text: "Check the remaining files.", selectedTarget: "macbook", origin: web },
        { text: "Now check here.", selectedTarget: "gsv", origin: web },
        { text: "A question from Telegram.", selectedTarget: undefined, origin: telegram },
        { text: "Another question.", selectedTarget: undefined, origin: telegram },
      ];
      for (const [index, item] of input.entries()) {
        process.store.messages.appendMessage("user", item.text, { ...item, runId: `run:${index}` });
      }
      const context = await process.history.buildContextMessages();
      expect(context.map((item) => item.content)).toEqual([
        "[From: GSV Web Desktop]\n[Directed endpoint: this GSV client.]\n[Selected target: macbook]\nClean up my downloads.",
        "[Selected target: macbook]\nCheck the remaining files.",
        "[Selected target: gsv]\nNow check here.",
        "[From: Telegram direct message]\n[Directed endpoint: this Telegram direct message.]\nA question from Telegram.",
        "Another question.",
      ]);
      const stored = process.store.messages.getMessages();
      expect(stored.map((item) => item.content)).toEqual(input.map((item) => item.text));
      const summary = renderCompactionTranscriptWindow(stored, 20_000).split("\n").map((line) => JSON.parse(line));
      expect(summary.map((item) => item.payload.selectedTarget)).toEqual(["macbook", "macbook", "gsv", undefined, undefined]);
    });
  });

  it("keeps target context when stored image bytes replace the fallback content", async () => {
    const stub = await initProcess("selected-target-media", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const key = `var/media/0/${process.pid}/fixture.png`;
      await env.STORAGE.put(key, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
        customMetadata: { uid: "0", gid: "0", mode: "400", processId: process.pid },
      });
      process.store.messages.appendMessage("user", "Check this image.", {
        selectedTarget: "macbook",
        media: JSON.stringify([{ type: "image", mimeType: "image/png", key, size: 3 }]),
      });
      const context = await process.history.buildContextMessages();
      expect(JSON.stringify(context)).toContain("[Selected target: macbook]");
      expect(JSON.stringify(context)).toContain('"type":"image"');
    });
  });
});
