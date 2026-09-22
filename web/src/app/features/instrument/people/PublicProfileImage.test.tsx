import { GSVClient } from "@humansandmachines/gsv/client";
import { bodyFromBytes, type PublicProfile } from "@humansandmachines/gsv/protocol";
import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { PublicProfileImage } from "./PublicProfileImage";

const profile: PublicProfile = {
  version: 2, domain: "gsv-federation/2/profile", actor: { shipId: "ship:person", subjectId: "subject:person" },
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, signature: "signature", revision: 1, publishedAtMs: 1,
  origin: "https://person.example", url: "https://person.example/@person", alias: "person", displayName: "Person", about: "",
  contactPolicy: "requests", representation: "human", avatar: { sha256: "1".repeat(64), url: "https://person.example/avatar.png", width: 2, height: 2, size: 4, contentType: "image/png" },
};
beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: "wss://space.example/ws", username: "person", connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("resolved profile images", () => {
  it("uses the gateway's binary image body without contacting the remote profile from the browser", async () => {
    const request = vi.spyOn(GSVClient.prototype, "request").mockResolvedValue({ data: { avatar: profile.avatar }, body: bodyFromBytes(new Uint8Array([1, 2, 3, 4])) });
    const directFetch = vi.spyOn(globalThis, "fetch");
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:profile-preview");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    const root = createTestRoot("profile image");
    let tree: ComponentChildren;
    function Harness() { tree = PublicProfileImage({ profile }); return null; }
    try {
      await root.render(<GatewayProvider><Harness /></GatewayProvider>);
      await vi.waitFor(() => expect(collectNodes(tree).find((node) => node.type === "img")?.props).toMatchObject({ src: "blob:profile-preview", alt: "Person’s profile image" }));
      expect(request).toHaveBeenCalledWith("profile.avatar.read", { sha256: profile.avatar!.sha256, profileUrl: profile.url }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
      expect(directFetch).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
    expect(revokeUrl).toHaveBeenCalledWith("blob:profile-preview");
  });
});
