import { afterEach, describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ConversationMessage, ConversationHistoryResult } from "@humansandmachines/gsv/protocol";
import { attributedDestination, isFirstUserSubmission, milestoneId } from "./acquisition";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const message = { id: "message:opaque-id", conversationId: "canonical-ship", sequence: 4, text: "PRIVATE TASK", author: { kind: "user", uid: 1000 }, origin: { kind: "client" }, createdAt: 1 } satisfies ConversationMessage;
function historyClient(pages: Partial<ConversationHistoryResult>[]) {
  const history = vi.fn();
  for (const page of pages) history.mockResolvedValueOnce(page);
  return { client: { conversation: { history } } as unknown as Pick<GSVClient, "conversation">, history };
}

describe("acquisition boundary", () => {
  it("preserves only approved UTM tags across signup and retains private onboarding fragments", () => {
    const source = "https://signup.ship.space/owner/signup/?utm_source=meta&utm_medium=paid-social&utm_campaign=human-backup&utm_content=photo&utm_term=founder&email=private&fbclid=private";
    const url = new URL(attributedDestination("https://new.ship.space/onboarding?signup=1#onboard_secret", source));
    expect(url.searchParams.size).toBe(6);
    expect(url.searchParams.get("utm_source")).toBe("meta");
    expect(url.hash).toBe("#onboard_secret");
    expect(url.href).not.toContain("private");
    expect(new URL(attributedDestination(url.href, "https://signup.ship.space/?utm_content=email%40example.com")).searchParams.get("utm_content")).toBe("photo");
  });

  it("only considers an acknowledged human client message with no earlier user message first", async () => {
    const system = { ...message, id: "greeting", sequence: 1, author: { kind: "process", uid: 1000, pid: "ship" } } satisfies ConversationMessage;
    const empty = historyClient([{ messages: [system], hasMore: false }]);
    expect(await isFirstUserSubmission(empty.client, message)).toBe(true);
    const previous = historyClient([{ messages: [{ ...message, sequence: 2, origin: { kind: "adapter", adapter: "whatsapp", accountId: "x", actorId: "x", surface: { kind: "dm", id: "x" } } }], hasMore: false }]);
    expect(await isFirstUserSubmission(previous.client, message)).toBe(false);
    expect(await isFirstUserSubmission(empty.client, system)).toBe(false);
  });

  it("checks older pages rather than calling a later send a first task", async () => {
    const previous = historyClient([
      { messages: [{ ...message, sequence: 3, author: { kind: "process", uid: 1000, pid: "ship" } }], hasMore: true },
      { messages: [{ ...message, sequence: 2 }], hasMore: false },
    ]);
    expect(await isFirstUserSubmission(previous.client, message)).toBe(false);
    expect(previous.history).toHaveBeenNthCalledWith(2, { conversationId: "canonical-ship", beforeSequence: 3, limit: 100 });
  });

  it("opaque IDs are stable through retries and contain no task or account text", async () => {
    const id = await milestoneId("FirstTaskSubmitted", message.id);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(await milestoneId("FirstTaskSubmitted", message.id)).toBe(id);
    expect(await milestoneId("CompleteRegistration", message.id)).not.toBe(id);
    expect(id).not.toContain("PRIVATE");
  });

  it("stays inert by default and only loads a first-party coordinator when explicitly enabled", async () => {
    vi.resetModules();
    const acquisition = await import("./acquisition");
    const scripts: Array<{ onload: () => void; src: string; dataset: Record<string, string> }> = [];
    const track = vi.fn();
    vi.stubGlobal("window", { location: new URL("https://new.ship.space/onboarding?utm_source=meta#onboard_secret"), shipAcquisition: { track }, shipAcquisitionReady: Promise.resolve() });
    vi.stubGlobal("document", { createElement: () => ({ dataset: {} }), head: { appendChild(script: typeof scripts[number]) { scripts.push(script); queueMicrotask(() => script.onload()); } } });
    vi.stubEnv("VITE_ACQUISITION_ENABLED", "false");
    acquisition.startAcquisition(); acquisition.captureRegistration(1000);
    expect(scripts).toHaveLength(0); expect(track).not.toHaveBeenCalled();
    vi.stubEnv("VITE_ACQUISITION_ENABLED", "true");
    acquisition.startAcquisition(); acquisition.startAcquisition(); acquisition.captureRegistration(1000);
    await vi.waitFor(() => expect(track).toHaveBeenCalledOnce());
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe("https://ship.space/acquisition-client.js");
    expect(scripts[0]?.dataset.acquisitionAttribution).toBe('{"utm_source":"meta"}');
    expect(track.mock.calls[0]?.[0]).toBe("CompleteRegistration");
    expect(track.mock.calls[0]?.[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(track.mock.calls)).not.toContain("new.ship.space");
    expect(JSON.stringify(track.mock.calls)).not.toContain("onboard_secret");
  });
});
