import { describe, expect, it, vi } from "vitest";
import { RoutedInferenceTransport } from "./transport";

describe("authorized inference transport", () => {
  it("honors cancellation that overtakes fetch without touching the target", async () => {
    const fetch = vi.fn();
    const target = new RoutedInferenceTransport(fetch);
    await target.abort("request-a");
    await expect(target.fetch("request-a", new Request("https://provider.invalid"))).rejects.toThrow("closed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["abort", "close"] as const)("cancels an unread body on %s and forbids request reuse", async (action) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn(async () => new Response(body));
    const target = new RoutedInferenceTransport(fetch);
    const response = await target.fetch("request-a", new Request("https://provider.invalid"));
    if (action === "abort") await target.abort("request-a");
    else target.close();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await expect(response.text()).rejects.toThrow();
    await expect(target.fetch("request-a", new Request("https://provider.invalid"))).rejects.toThrow("closed");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a late target response after the generation has closed", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const target = new RoutedInferenceTransport(fetch);
    const pending = target.fetch("request-a", new Request("https://provider.invalid"));
    target.close();
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await expect(pending).rejects.toThrow("cancelled");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
