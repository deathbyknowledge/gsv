import { afterEach, describe, expect, it, vi } from "vitest";
import { attributedDestination, milestoneId } from "./acquisition";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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

  it("uses a stable opaque registration ID without exposing an account address", async () => {
    const id = await milestoneId("CompleteRegistration", "https://private.ship.space:1000");
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(await milestoneId("CompleteRegistration", "https://private.ship.space:1000")).toBe(id);
    expect(await milestoneId("CompleteRegistration", "https://different.ship.space:1000")).not.toBe(id);
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

  it("keeps production reporting off on local, insecure and other operators' domains", async () => {
    for (const origin of ["http://localhost:5173", "http://new.ship.space", "https://another-operator.example", "https://ship.space.example"]) {
      vi.resetModules();
      const acquisition = await import("./acquisition");
      const appendChild = vi.fn();
      vi.stubEnv("VITE_ACQUISITION_ENABLED", "true");
      vi.stubGlobal("window", { location: new URL(origin) });
      vi.stubGlobal("document", { head: { appendChild } });
      acquisition.startAcquisition();
      acquisition.captureRegistration(1000);
      expect(appendChild).not.toHaveBeenCalled();
    }
  });
});
