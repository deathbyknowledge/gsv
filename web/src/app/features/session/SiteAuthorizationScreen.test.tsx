import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteAuthorization, SiteResult } from "@humansandmachines/gsv/protocol";
import { collectNodes, createTestRoot, deferred } from "../../testing/testHarness";
import { SiteConsent } from "./SiteAuthorizationScreen";

const siteId = `site-${"a".repeat(32)}`;
const nonce = "unique-consent-request-1234";
const site: SiteResult = { site: { id: siteId, slug: "plans", origin: "https://plans.content.example", createdAtMs: 1 },
  publication: { revision: 1, releaseId: "release", publishedAtMs: 1 }, manifest: null, shareUrl: "https://alice.space.example/public/plans" };
const authorization: SiteAuthorization = { token: "scoped-secret", tokenId: "token-1", expiresAtMs: Date.now() + 3_600_000,
  installationId: "installation", siteId, siteOrigin: site.site.origin, gatewayOrigin: "https://alice.space.example",
  calls: ["r12y.list", "r12y.get"], signals: ["r12y.changed"] };
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const opener = { closed: false, postMessage: vi.fn() };
  const base = { opener, close: vi.fn(), location: { origin: authorization.gatewayOrigin, search: `?site=${siteId}&nonce=${nonce}` } };
  const browser = { ...base, top: base };
  browser.top = browser;
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", {});
  const client = { site: { get: vi.fn(async () => site), authorize: vi.fn(async () => authorization) }, sys: { token: { revoke: vi.fn(async () => ({ revoked: true })) } } };
  const root = createTestRoot("site owner consent");
  let tree: ComponentChildren;
  function Harness() { tree = SiteConsent({ client }); return null; }
  const button = (label: string) => collectNodes(tree).find(node => node.props.label === label)!;
  return { browser, client, root, button, Harness };
}

describe("site consent", () => {
  it("issues only after Allow and sends only the scoped credential to the registered origin", async () => {
    const f = fixture();
    try {
      await f.root.render(<f.Harness />);
      await vi.waitFor(() => expect(f.button("Allow").props.disabled).toBe(false));
      expect(f.client.site.authorize).not.toHaveBeenCalled();
      await act(() => f.button("Allow").props.onClick?.());
      await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalled());
      expect(f.client.site.authorize).toHaveBeenCalledExactlyOnceWith({ siteId });
      expect(f.browser.opener.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: "gsv.site.authorization", nonce, authorization }, site.site.origin);
      expect(f.client.sys.token.revoke).not.toHaveBeenCalled();
    } finally { await f.root.unmount(); }
  });

  it("cancels without issuing a credential", async () => {
    const f = fixture();
    try {
      await f.root.render(<f.Harness />);
      await vi.waitFor(() => expect(f.button("Allow").props.disabled).toBe(false));
      await act(() => f.button("Cancel").props.onClick?.());
      expect(f.client.site.authorize).not.toHaveBeenCalled();
      expect(f.browser.opener.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: "gsv.site.authorization.cancelled", nonce, siteId }, site.site.origin);
    } finally { await f.root.unmount(); }
  });

  it.each(["closed", "unmounted"] as const)("revokes issuance abandoned when %s", async outcome => {
    const f = fixture(), pending = deferred<SiteAuthorization>();
    f.client.site.authorize.mockReturnValue(pending.promise);
    try {
      await f.root.render(<f.Harness />);
      await vi.waitFor(() => expect(f.button("Allow").props.disabled).toBe(false));
      await act(() => f.button("Allow").props.onClick?.());
      expect(f.client.site.authorize).toHaveBeenCalledOnce();
      if (outcome === "closed") f.browser.opener.closed = true;
      else await f.root.unmount();
      await act(() => pending.resolve(authorization));
      await vi.waitFor(() => expect(f.client.sys.token.revoke).toHaveBeenCalledExactlyOnceWith({ tokenId: authorization.tokenId }));
      expect(f.browser.opener.postMessage).not.toHaveBeenCalled();
    } finally { await f.root.unmount(); }
  });

  it("rejects framing before loading site details", async () => {
    const f = fixture();
    f.browser.top = { ...f.browser };
    try {
      await f.root.render(<f.Harness />);
      expect(f.client.site.get).not.toHaveBeenCalled();
      expect(f.button("Allow").props.disabled).toBe(true);
    } finally { await f.root.unmount(); }
  });
});
