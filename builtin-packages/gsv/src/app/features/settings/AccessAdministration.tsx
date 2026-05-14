import { useEffect, useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import { formatDate } from "./settings-domain";
import type {
  AccessToken,
  AdministrationState,
  CreateAccessTokenArgs,
  CreatedAccessToken,
  CreateIdentityLinkArgs,
  IdentityLink,
  TokenKind,
} from "./types";
import { linkActionId } from "./useAdministration";

const TOKEN_KINDS: TokenKind[] = ["user", "service", "node"];

export function AccessView({
  state,
  issuedToken,
  pendingAction,
  onCreateToken,
  onRevokeToken,
  onConsumeCode,
  onCreateLink,
  onRemoveLink,
}: {
  state: AdministrationState;
  issuedToken: CreatedAccessToken | null;
  pendingAction: string | null;
  onCreateToken: (args: CreateAccessTokenArgs) => Promise<void>;
  onRevokeToken: (token: AccessToken) => void;
  onConsumeCode: (code: string) => void;
  onCreateLink: (link: CreateIdentityLinkArgs) => void;
  onRemoveLink: (link: IdentityLink) => void;
}) {
  const [tokenForm, setTokenForm] = useState({
    kind: "user" as TokenKind,
    label: "",
    allowedDeviceId: "",
    expiresAt: "",
  });
  const [code, setCode] = useState("");
  const [manualLink, setManualLink] = useState({ adapter: "", accountId: "", actorId: "" });

  useEffect(() => {
    if (issuedToken) {
      setTokenForm({ kind: "user", label: "", allowedDeviceId: "", expiresAt: "" });
    }
  }, [issuedToken]);

  return (
    <section class="gsv-admin-access">
      <section class="gsv-admin-panel">
        <header class="gsv-admin-panel-head">
          <div>
            <h4>Access tokens</h4>
            <p>Issue credentials for users, services, and driver nodes. Revocation takes effect immediately.</p>
          </div>
        </header>

        {issuedToken ? (
          <div class="gsv-admin-secret">
            <strong>New token issued</strong>
            <code>{issuedToken.token}</code>
            <span>Store this secret now. It is only returned once.</span>
          </div>
        ) : null}

        <div class="gsv-admin-form-grid">
          <label><span>Kind</span><select value={tokenForm.kind} onChange={(event) => {
            const kind = event.currentTarget.value as TokenKind;
            setTokenForm((current) => ({ ...current, kind, allowedDeviceId: kind === "node" ? current.allowedDeviceId : "" }));
          }}>{TOKEN_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          <label><span>Label</span><input value={tokenForm.label} onInput={(event) => setTokenForm((current) => ({ ...current, label: event.currentTarget.value }))} /></label>
          <label><span>Expires at</span><input type="datetime-local" value={tokenForm.expiresAt} onInput={(event) => setTokenForm((current) => ({ ...current, expiresAt: event.currentTarget.value }))} /></label>
          {tokenForm.kind === "node" ? (
            <label><span>Allowed device</span><input placeholder="device id" value={tokenForm.allowedDeviceId} onInput={(event) => setTokenForm((current) => ({ ...current, allowedDeviceId: event.currentTarget.value }))} /></label>
          ) : null}
        </div>
        <div class="gsv-admin-actions">
          <ActionButton icon="key" label="Issue token" busyLabel="Issuing" busy={pendingAction === "create-token"} onClick={() => void onCreateToken({
            kind: tokenForm.kind,
            label: tokenForm.label,
            allowedDeviceId: tokenForm.allowedDeviceId,
            expiresAt: tokenForm.expiresAt ? new Date(tokenForm.expiresAt).getTime() : null,
          })} />
        </div>

        <TokenList tokens={state.tokens} pendingAction={pendingAction} onRevoke={onRevokeToken} />
      </section>

      <section class="gsv-admin-panel">
        <header class="gsv-admin-panel-head">
          <div>
            <h4>Identity links</h4>
            <p>Redeem link codes or manually bind external adapter identities to the current user.</p>
          </div>
        </header>

        <div class="gsv-admin-inline-form">
          <input value={code} placeholder="link code" onInput={(event) => setCode(event.currentTarget.value)} />
          <ActionButton icon="key" label="Redeem" busyLabel="Redeeming" busy={pendingAction === "consume-link"} onClick={() => {
            onConsumeCode(code);
            setCode("");
          }} />
        </div>

        <div class="gsv-admin-form-grid">
          <label><span>Adapter</span><input placeholder="discord" value={manualLink.adapter} onInput={(event) => setManualLink((current) => ({ ...current, adapter: event.currentTarget.value }))} /></label>
          <label><span>Account</span><input value={manualLink.accountId} onInput={(event) => setManualLink((current) => ({ ...current, accountId: event.currentTarget.value }))} /></label>
          <label><span>Actor</span><input value={manualLink.actorId} onInput={(event) => setManualLink((current) => ({ ...current, actorId: event.currentTarget.value }))} /></label>
        </div>
        <div class="gsv-admin-actions">
          <ActionButton icon="external" label="Create link" busyLabel="Creating" busy={pendingAction === "create-link"} onClick={() => {
            onCreateLink(manualLink);
            setManualLink({ adapter: "", accountId: "", actorId: "" });
          }} />
        </div>

        <LinkList links={state.links} pendingAction={pendingAction} onRemove={onRemoveLink} />
      </section>
    </section>
  );
}

function TokenList({
  tokens,
  pendingAction,
  onRevoke,
}: {
  tokens: AccessToken[];
  pendingAction: string | null;
  onRevoke: (token: AccessToken) => void;
}) {
  return (
    <div class="gsv-admin-list">
      {tokens.length === 0 ? (
        <div class="gsv-empty-state"><h3>No tokens</h3><p>No access tokens are currently visible.</p></div>
      ) : tokens.map((token) => {
        const revoked = typeof token.revokedAt === "number";
        return (
          <article class="gsv-admin-record" key={token.tokenId}>
            <div>
              <strong><code>{token.tokenPrefix}</code></strong>
              <span>{token.label ?? token.tokenId}</span>
            </div>
            <dl>
              <div><dt>Kind</dt><dd>{token.kind}</dd></div>
              <div><dt>UID</dt><dd>{token.uid}</dd></div>
              <div><dt>Scope</dt><dd>{token.allowedDeviceId ? `device ${token.allowedDeviceId}` : token.allowedRole ?? "default"}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(token.createdAt)}</dd></div>
              <div><dt>Last used</dt><dd>{formatDate(token.lastUsedAt)}</dd></div>
              <div><dt>Expires</dt><dd>{formatDate(token.expiresAt)}</dd></div>
            </dl>
            <ActionButton icon="trash" label={revoked ? "Revoked" : "Revoke"} busyLabel="Revoking" busy={pendingAction === `revoke:${token.tokenId}`} variant="danger" disabled={revoked} onClick={() => {
              if (!window.confirm(`Revoke token ${token.tokenPrefix}?`)) return;
              onRevoke(token);
            }} />
          </article>
        );
      })}
    </div>
  );
}

function LinkList({
  links,
  pendingAction,
  onRemove,
}: {
  links: IdentityLink[];
  pendingAction: string | null;
  onRemove: (link: IdentityLink) => void;
}) {
  return (
    <div class="gsv-admin-list">
      {links.length === 0 ? (
        <div class="gsv-empty-state"><h3>No links</h3><p>No external identities are linked.</p></div>
      ) : links.map((link) => (
        <article class="gsv-admin-record" key={`${link.adapter}:${link.accountId}:${link.actorId}`}>
          <div>
            <strong>{link.adapter}</strong>
            <span>uid {link.uid} / linked by {link.linkedByUid}</span>
          </div>
          <dl>
            <div><dt>Account</dt><dd><code>{link.accountId}</code></dd></div>
            <div><dt>Actor</dt><dd><code>{link.actorId}</code></dd></div>
            <div><dt>Created</dt><dd>{formatDate(link.createdAt)}</dd></div>
          </dl>
          <ActionButton icon="trash" label="Unlink" busyLabel="Removing" busy={pendingAction === linkActionId(link)} variant="danger" onClick={() => {
            if (!window.confirm(`Unlink ${link.adapter}:${link.accountId}?`)) return;
            onRemove(link);
          }} />
        </article>
      ))}
    </div>
  );
}
