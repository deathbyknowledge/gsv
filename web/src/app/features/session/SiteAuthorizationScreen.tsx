import { useEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { SiteResult } from "@humansandmachines/gsv/protocol";
import { siteIdSchema } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { Button } from "../../components/ui/Button";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SessionError } from "./SessionChrome";
import { AuthLayout } from "./AuthLayout";
import "./SiteAuthorizationScreen.css";

type ConsentClient = {
  site: Pick<GSVClient["site"], "get" | "authorize">;
  sys: { token: Pick<GSVClient["sys"]["token"], "revoke"> };
};

const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export function SiteAuthorizationScreen() {
  const { client } = useGateway();
  return <SiteConsent client={client} />;
}

export function SiteConsent({ client }: { client: ConsentClient }) {
  const [request] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const site = siteIdSchema.safeParse(params.get("site"));
    const nonce = nonceSchema.safeParse(params.get("nonce"));
    if (!site.success || !nonce.success || window.top !== window || !window.opener) return null;
    return { siteId: site.data, nonce: nonce.data, opener: window.opener };
  });
  const [site, setSite] = useState<SiteResult | null>(null);
  const [error, setError] = useState<string | null>(request ? null : "Open this request from the site you want to connect.");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const active = useRef(true);
  const issuing = useRef(false);

  useEffect(() => {
    active.current = true;
    if (request) void client.site.get({ siteId: request.siteId }).then(result => {
      if (!active.current) return;
      if (!result.publication.releaseId) throw new Error("This site is not published.");
      setSite(result);
    }).catch(cause => { if (active.current) setError(cause instanceof Error ? cause.message : "Could not load this site."); });
    return () => { active.current = false; };
  }, [client, request]);

  const allow = async () => {
    if (!request || !site || issuing.current || done) return;
    issuing.current = true; setBusy(true); setError(null);
    let tokenId: string | undefined;
    try {
      if (request.opener.closed) throw new Error("The site was closed. Open it and try again.");
      const authorization = await client.site.authorize({ siteId: request.siteId });
      tokenId = authorization.tokenId;
      if (!active.current || request.opener.closed) throw new Error("The site was closed before connecting.");
      if (authorization.siteId !== request.siteId || authorization.siteOrigin !== site.site.origin
        || authorization.gatewayOrigin !== window.location.origin) throw new Error("The site's identity changed. Open it and try again.");
      request.opener.postMessage({ kind: "gsv.site.authorization", nonce: request.nonce, authorization }, authorization.siteOrigin);
      tokenId = undefined;
      setDone(true);
      window.close();
    } catch (cause) {
      if (tokenId) {
        try { await client.sys.token.revoke({ tokenId }); }
        catch (revokeError) {
          if (active.current) setError(`Connection was interrupted. Remove the site's token in Settings. ${revokeError instanceof Error ? revokeError.message : "Revocation failed."}`);
          return;
        }
      }
      if (active.current) setError(cause instanceof Error ? cause.message : "Could not connect this site.");
    } finally {
      issuing.current = false;
      if (active.current) setBusy(false);
    }
  };
  const cancel = () => {
    if (request && site && !request.opener.closed) {
      request.opener.postMessage({ kind: "gsv.site.authorization.cancelled", nonce: request.nonce, siteId: request.siteId }, site.site.origin);
    }
    window.close();
  };

  return <AuthLayout background="none" visible surfaceClass="gsv-auth-surface-login gsv-site-consent">
    <section class="gsv-site-consent-panel" aria-busy={busy}>
      <SectionHeader title={done ? "Connected" : "Connect this site"} titleSize="title" divider />
      {done ? <p>You can return to the site.</p> : site ? <>
        <h1>{site.manifest?.title || site.site.slug}</h1>
        <p class="gsv-site-consent-origin">{site.site.origin}</p>
        <p>Allow this site to read your plans and their details?</p>
        <p class="gsv-site-consent-duration">Read-only · up to 1 hour</p>
      </> : !error ? <p role="status">Loading…</p> : null}
      <SessionError message={error} />
      {!done && <div class="gsv-site-consent-actions">
        <Button variant="secondary" label="Cancel" disabled={busy} onClick={cancel} />
        <Button label={busy ? "Connecting…" : "Allow"} disabled={!site || busy} onClick={() => void allow()} />
      </div>}
    </section>
  </AuthLayout>;
}
