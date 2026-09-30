import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import { assertFederationDestination, fetchFederationJson } from "./http";

describe("federation HTTP destination boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "http://remote.example", "https://localhost", "https://localhost.", "https://host.local", "https://metadata.google.internal",
    "https://127.0.0.1", "https://2130706433", "https://0x7f000001", "https://10.0.0.1", "https://172.16.1.2",
    "https://192.168.1.2", "https://169.254.169.254", "https://100.64.0.1", "https://[::1]",
    "https://[::ffff:127.0.0.1]", "https://[fd00::1]", "https://[fe80::1]", "https://[2001:db8::1]",
    "https://user:pass@remote.example", "https://remote.example/#fragment",
  ])("refuses nonpublic destination %s before fetching", async (url) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(fetchFederationJson(url, { method: "GET" }, context())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps public delivery on the nonredirecting global fetch path", async () => {
    expect(() => assertFederationDestination("https://[2606:4700:4700::1111]/")).not.toThrow();
    expect(() => assertFederationDestination("https://1.1.1.1/")).not.toThrow();
    const cancel = vi.fn();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { location: "https://127.0.0.1/private" },
    }));
    await expect(fetchFederationJson("https://remote.example/ship", { method: "GET" }, context())).rejects.toThrow("302");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://remote.example/ship", expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("requires both the explicit development setting and a local installation for loopback", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    const url = "http://peer.localhost:8788/ship";
    await expect(fetchFederationJson(url, {}, context("https://space.example", true))).rejects.toThrow();
    await expect(fetchFederationJson(url, {}, context("http://local.localhost:8787"))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(fetchFederationJson(url, {}, context("http://local.localhost:8787", true))).resolves.toEqual({ ok: true });
    expect(() => assertFederationDestination("https://192.168.1.2", true)).toThrow();
  });
});

function context(origin = "https://space.example", local = false): KernelContext {
  const value = {
    env: local ? { GSV_FEDERATION_LOCAL_DEVELOPMENT: "1" as const } : {},
    installationIdentity: { installationId: "inst_test", handle: "space", canonicalOrigin: origin },
  };
  // SAFETY: HTTP uses only the trusted installation identity and deployment setting in this fixture.
  return value as KernelContext;
}
