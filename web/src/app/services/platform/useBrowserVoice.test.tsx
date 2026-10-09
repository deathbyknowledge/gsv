import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GSVClient } from "@humansandmachines/gsv";
import { createTestRoot, deferred } from "../../testing/testHarness";
import { installBrowserAudio } from "../../testing/browserAudio";
import { useBrowserVoice } from "./useBrowserVoice";

const roots: ReturnType<typeof createTestRoot>[] = [];
beforeEach(() => {
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Let recorder events and the upload promise settle before Preact flushes updates.
const settle = (action: () => void) => act(async () => {
  action();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

async function mounted() {
  const input = installBrowserAudio();
  const client = new GSVClient({ url: "ws://voice.test" });
  const response = deferred<{ data: { text: string; provider: string; model: string } }>();
  const request = vi.spyOn(client, "request").mockImplementation(() => response.promise);
  let value = "typed", caret = value.length;
  let control: ReturnType<typeof useBrowserVoice>;
  const prompt = { current: {
    selection: () => ({ value, start: caret, end: caret }),
    setValue: (text: string, position = text.length) => { value = text; caret = position; control?.onInput(text); },
    focus: vi.fn(),
  } };
  function Probe({ scope, enabled }: { scope: string; enabled: boolean }) {
    control = useBrowserVoice({ client, prompt, pid: "p-ship", scope, enabled });
    return null;
  }
  const root = createTestRoot("browser voice");
  roots.push(root);
  const render = (scope = "ship", enabled = true) => root.render(<Probe scope={scope} enabled={enabled} />);
  await render();
  const start = () => settle(() => { void control.start(); });
  const stop = () => settle(() => control.stop());
  const finish = (text = "spoken words") => settle(() => response.resolve({ data: { text, provider: "test", model: "test" } }));
  return { input, request, response, prompt, render, start, stop, finish, root, control: () => control, value: () => value };
}

describe("web voice composition", () => {
  it("uploads audio through the authenticated syscall and inserts into the current draft without sending", async () => {
    const app = await mounted();
    await app.start();
    expect(app.control().phase).toBe("recording");
    expect(app.control().stream).toBe(app.input.stream);
    expect(app.request).not.toHaveBeenCalled();
    await app.stop();
    expect(app.input.stopTrack).toHaveBeenCalled();
    expect(app.control().phase).toBe("transcribing");
    expect(app.control().stream).toBeNull();
    const [method, args, options] = app.request.mock.calls[0];
    expect(method).toBe("ai.transcription.create");
    expect(args).toEqual({ pid: "p-ship", audio: { mimeType: "audio/webm;codecs=opus" }, mode: "transcribe" });
    expect(options?.signal?.aborted).toBe(false);
    expect(options?.body?.length).toBe(5);
    expect(await new Response(options?.body?.stream).text()).toBe("audio");
    app.prompt.current.setValue("typed edits after", 11);
    await app.finish();
    expect(app.value()).toBe("typed edits spoken words after");
    expect(app.prompt.current.focus).toHaveBeenCalledOnce();
    expect(app.control().phase).toBe("idle");
    expect(app.request).toHaveBeenCalledOnce();
  });

  it("Enter stops recording and waits for review before allowing submission", async () => {
    const app = await mounted();
    await app.start();
    await settle(() => expect(app.control().interceptSubmit()).toBe(true));
    expect(app.control().phase).toBe("transcribing");
    expect(app.control().interceptSubmit()).toBe(true);
    await app.finish();
    expect(app.control().interceptSubmit()).toBe(false);
  });

  it.each(["cancel", "scope", "disabled", "unmount", "clear", "pagehide", "hidden"])("discards stale transcription after %s", async (reason) => {
    const app = await mounted();
    await app.start();
    await app.stop();
    const signal = app.request.mock.calls[0][2]?.signal;
    if (reason === "scope") await app.render("different conversation");
    else if (reason === "disabled") await app.render("ship", false);
    else if (reason === "unmount") await app.root.unmount();
    else await settle(() => {
      if (reason === "cancel") app.control().cancel();
      if (reason === "clear") app.prompt.current.setValue("");
      if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
      if (reason === "hidden") {
        Object.assign(document, { visibilityState: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    expect(signal?.aborted).toBe(true);
    await app.finish();
    expect(app.value()).toBe(reason === "clear" ? "" : "typed");
    expect(app.prompt.current.focus).not.toHaveBeenCalled();
  });

  it("releases a late permission grant after leaving Zen", async () => {
    const app = await mounted();
    const permission = deferred<typeof app.input.stream>();
    app.input.microphone.mockReturnValue(permission.promise);
    await app.start();
    expect(app.control().phase).toBe("permission");
    await app.render("ship", false);
    await settle(() => permission.resolve(app.input.stream));
    expect(app.input.stopTrack).toHaveBeenCalled();
    expect(app.input.recorders).toHaveLength(0);
    expect(app.request).not.toHaveBeenCalled();
  });

  it("restores focus to the preserved draft when recording is cancelled explicitly", async () => {
    const app = await mounted();
    await app.start();
    await settle(() => app.control().cancel(true));
    expect(app.value()).toBe("typed");
    expect(app.control().stream).toBeNull();
    expect(app.input.stopTrack).toHaveBeenCalled();
    expect(app.prompt.current.focus).toHaveBeenCalledOnce();
  });

  it("retries a failed upload with retained audio and the provider's error visible", async () => {
    const app = await mounted();
    app.request.mockRejectedValueOnce(new Error("Transcription service unavailable"));
    await app.start();
    await app.stop();
    expect(app.control().error).toBe("Transcription service unavailable");
    expect(app.control().canRetry).toBe(true);
    await settle(() => app.control().retry());
    await app.finish();
    expect(app.value()).toBe("typed spoken words");
    expect(app.input.microphone).toHaveBeenCalledOnce();
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it("allows typed submission after an error and discards the pending audio", async () => {
    const app = await mounted();
    app.request.mockRejectedValueOnce(new Error("Transcription service unavailable"));
    await app.start();
    await app.stop();
    await settle(() => expect(app.control().interceptSubmit()).toBe(false));
    expect(app.control().canRetry).toBe(false);
    expect(app.value()).toBe("typed");
  });

  it("explains denied permission and empty speech without changing the draft", async () => {
    const app = await mounted();
    app.input.microphone.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    await app.start();
    expect(app.control().error).toContain("site settings");
    await app.start();
    await app.stop();
    await app.finish(" ");
    expect(app.control().error).toContain("No speech");
    expect(app.control().canRetry).toBe(false);
    expect(app.value()).toBe("typed");
    await app.start();
    expect(app.control().phase).toBe("recording");
  });
});
