import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/testHarness";
import { installBrowserAudio } from "../../testing/browserAudio";
import { browserRecordingUnavailable, captureBrowserAudio, MAX_VOICE_BYTES, MAX_VOICE_SECONDS } from "./browserAudio";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("browser audio capture", () => {
  it("collects the final chunk before resolving and releases the microphone at stop", async () => {
    const input = installBrowserAudio();
    const started = vi.fn();
    const result = captureBrowserAudio(new AbortController().signal, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    input.recorders[0].ondataavailable?.({ data: new Blob(["first "]) });
    started.mock.calls[0][0]();
    expect(input.stopTrack).toHaveBeenCalled();
    const audio = await result;
    expect(await audio.text()).toBe("first audio");
    expect(audio.type).toBe("audio/webm;codecs=opus");
    expect(input.microphone).toHaveBeenCalledWith({ audio: true });
  });

  it("uses MP4 when it is the browser's supported format", async () => {
    const input = installBrowserAudio();
    input.supported.mockImplementation((type) => type === "audio/mp4");
    const result = captureBrowserAudio(new AbortController().signal, (stop) => stop());
    expect((await result).type).toBe("audio/mp4");
  });

  it("uses the recorder's actual format when none of the preferred formats is supported", async () => {
    const input = installBrowserAudio();
    input.supported.mockReturnValue(false);
    const result = captureBrowserAudio(new AbortController().signal, (stop) => stop());
    expect((await result).type).toBe("audio/webm");
  });

  it("releases a microphone granted after cancellation without starting a recorder", async () => {
    const input = installBrowserAudio();
    const permission = deferred<typeof input.stream>();
    input.microphone.mockReturnValue(permission.promise);
    const abort = new AbortController();
    const started = vi.fn();
    const result = captureBrowserAudio(abort.signal, started);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    permission.resolve(input.stream);
    await rejected;
    expect(input.stopTrack).toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(input.recorders).toHaveLength(0);
  });

  it("discards cancellation output instead of uploading a partial recording", async () => {
    const input = installBrowserAudio();
    const abort = new AbortController();
    const result = captureBrowserAudio(abort.signal, () => {});
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(input.recorders).toHaveLength(1));
    abort.abort();
    await rejected;
    expect(input.recorders[0].stop).toHaveBeenCalledOnce();
    expect(input.stopTrack).toHaveBeenCalled();
  });

  it("finishes on microphone removal and on the duration limit", async () => {
    vi.useFakeTimers();
    const input = installBrowserAudio();
    const result = captureBrowserAudio(new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(MAX_VOICE_SECONDS * 1000);
    expect((await result).size).toBeGreaterThan(0);
    const removed = captureBrowserAudio(new AbortController().signal, () => input.track.dispatchEvent(new Event("ended")));
    expect((await removed).size).toBeGreaterThan(0);
    expect(input.stopTrack).toHaveBeenCalled();
  });

  it("rejects oversized, empty and failed recordings and releases their microphone", async () => {
    const input = installBrowserAudio();
    await expect(captureBrowserAudio(new AbortController().signal, () => {
      input.recorders[0].ondataavailable?.({ data: new Blob([new Uint8Array(MAX_VOICE_BYTES + 1)]) });
    })).rejects.toThrow("too large");
    await expect(captureBrowserAudio(new AbortController().signal, (stop) => {
      input.recorders[1].finalData = new Blob([]);
      stop();
    })).rejects.toThrow("No audio");
    await expect(captureBrowserAudio(new AbortController().signal, () => {
      input.recorders[2].onerror?.(new Event("error"));
    })).rejects.toThrow("recording failed");
    expect(input.recorders.every((recorder) => recorder.state === "inactive")).toBe(true);
    expect(input.stopTrack).toHaveBeenCalled();
  });

  it("explains missing secure context and browser support without requesting the microphone", () => {
    const input = installBrowserAudio();
    vi.stubGlobal("isSecureContext", false);
    expect(browserRecordingUnavailable()).toContain("HTTPS");
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {});
    expect(browserRecordingUnavailable()).toContain("unavailable");
    expect(input.microphone).not.toHaveBeenCalled();
  });
});
