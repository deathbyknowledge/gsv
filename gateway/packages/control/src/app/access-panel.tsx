import { useEffect, useState } from "preact/hooks";
import type { ControlCreatedToken, ControlLink, ControlToken, CreateTokenArgs, ControlTokenKind } from "./types";

type AccessPanelProps = {
  tokens: ControlToken[];
  links: ControlLink[];
  issuedToken: ControlCreatedToken | null;
  pendingAction: string | null;
  onCreateToken: (args: CreateTokenArgs) => Promise<void>;
  onRevokeToken: (tokenId: string) => Promise<void>;
  onConsumeLinkCode: (code: string) => Promise<void>;
  onCreateLink: (args: { adapter: string; accountId: string; actorId: string }) => Promise<void>;
  onUnlink: (link: ControlLink) => Promise<void>;
};

const TOKEN_KINDS: ControlTokenKind[] = ["user", "service", "node"];

export function AccessPanel({
  tokens,
  links,
  issuedToken,
  pendingAction,
  onCreateToken,
  onRevokeToken,
  onConsumeLinkCode,
  onCreateLink,
  onUnlink,
}: AccessPanelProps) {
  const [tokenForm, setTokenForm] = useState({
    kind: "user" as ControlTokenKind,
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
    <div class="control-grid">
      <section class="control-card">
        <header class="control-card__header">
          <div>
            <h2>Access tokens</h2>
            <p>Create user, service, or node credentials and revoke them when they are no longer needed.</p>
          </div>
        </header>
        {issuedToken ? (
          <div class="control-flash control-flash--success">
            <strong>New token issued</strong>
            <code>{issuedToken.token}</code>
            <span>Store it now. This secret is only returned once.</span>
          </div>
        ) : null}
        <div class="control-inline-form control-inline-form--stacked">
          <label>
            <span>Kind</span>
            <select
              class="control-field"
              value={tokenForm.kind}
              onChange={(event) => {
                const target = event.currentTarget as HTMLSelectElement;
                setTokenForm((current) => ({
                  ...current,
                  kind: target.value as ControlTokenKind,
                  allowedDeviceId: target.value === "node" ? current.allowedDeviceId : "",
                }));
              }}
            >
              {TOKEN_KINDS.map((kind) => (
                <option value={kind} key={kind}>{kind}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Label</span>
            <input
              class="control-field"
              type="text"
              value={tokenForm.label}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setTokenForm((current) => ({ ...current, label: target.value }));
              }}
            />
          </label>
          <label>
            <span>Expires at</span>
            <input
              class="control-field"
              type="datetime-local"
              value={tokenForm.expiresAt}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setTokenForm((current) => ({ ...current, expiresAt: target.value }));
              }}
            />
          </label>
          {tokenForm.kind === "node" ? (
            <label>
              <span>Allowed device</span>
              <input
                class="control-field"
                type="text"
                placeholder="device id"
                value={tokenForm.allowedDeviceId}
                onInput={(event) => {
                  const target = event.currentTarget as HTMLInputElement;
                  setTokenForm((current) => ({ ...current, allowedDeviceId: target.value }));
                }}
              />
            </label>
          ) : null}
          <button
            class="control-button control-button--primary"
            disabled={pendingAction === "create-token"}
            onClick={() => void onCreateToken({
              kind: tokenForm.kind,
              label: tokenForm.label,
              allowedDeviceId: tokenForm.allowedDeviceId,
              expiresAt: tokenForm.expiresAt ? new Date(tokenForm.expiresAt).getTime() : null,
            })}
          >
            {pendingAction === "create-token" ? "Issuing…" : "Issue token"}
          </button>
        </div>
        <div class="control-table-wrap">
          <table class="control-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Kind</th>
                <th>Scope</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 ? (
                <tr>
                  <td colSpan={6} class="control-empty-cell">No tokens issued.</td>
                </tr>
              ) : tokens.map((token) => (
                <tr key={token.tokenId}>
                  <td>
                    <code>{token.tokenPrefix}</code>
                    <div class="control-subtle">{token.label ?? token.tokenId}</div>
                  </td>
                  <td><span class="control-pill">{token.kind}</span></td>
                  <td>
                    {token.allowedDeviceId ? <div>device: {token.allowedDeviceId}</div> : null}
                    <div class="control-subtle">role: {token.allowedRole ?? "default"}</div>
                  </td>
                  <td>{formatDate(token.createdAt)}</td>
                  <td>{token.lastUsedAt ? formatDate(token.lastUsedAt) : "never"}</td>
                  <td class="control-actions-cell">
                    <button
                      class="control-button control-button--danger"
                      disabled={pendingAction === `revoke:${token.tokenId}` || token.revokedAt !== null}
                      onClick={() => {
                        if (!window.confirm(`Revoke token ${token.tokenPrefix}?`)) {
                          return;
                        }
                        void onRevokeToken(token.tokenId);
                      }}
                    >
                      {token.revokedAt ? "Revoked" : pendingAction === `revoke:${token.tokenId}` ? "Revoking…" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section class="control-card">
        <header class="control-card__header">
          <div>
            <h2>Identity links</h2>
            <p>Redeem link codes or manually connect adapter identities to the current user.</p>
          </div>
        </header>
        <div class="control-inline-form control-inline-form--stacked">
          <label>
            <span>Link code</span>
            <input
              class="control-field"
              type="text"
              value={code}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setCode(target.value);
              }}
            />
          </label>
          <button
            class="control-button control-button--primary"
            disabled={pendingAction === "consume-link"}
            onClick={() => void onConsumeLinkCode(code).then(() => setCode(""))}
          >
            {pendingAction === "consume-link" ? "Linking…" : "Redeem code"}
          </button>
        </div>
        <div class="control-inline-form control-inline-form--stacked control-inline-form--top-gap">
          <label>
            <span>Adapter</span>
            <input
              class="control-field"
              type="text"
              placeholder="discord"
              value={manualLink.adapter}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setManualLink((current) => ({ ...current, adapter: target.value }));
              }}
            />
          </label>
          <label>
            <span>Account ID</span>
            <input
              class="control-field"
              type="text"
              value={manualLink.accountId}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setManualLink((current) => ({ ...current, accountId: target.value }));
              }}
            />
          </label>
          <label>
            <span>Actor ID</span>
            <input
              class="control-field"
              type="text"
              value={manualLink.actorId}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setManualLink((current) => ({ ...current, actorId: target.value }));
              }}
            />
          </label>
          <button
            class="control-button"
            disabled={pendingAction === "create-link"}
            onClick={() => void onCreateLink(manualLink).then(() => {
              setManualLink({ adapter: "", accountId: "", actorId: "" });
            })}
          >
            {pendingAction === "create-link" ? "Linking…" : "Create link"}
          </button>
        </div>
        <div class="control-table-wrap control-table-wrap--top-gap">
          <table class="control-table">
            <thead>
              <tr>
                <th>Adapter</th>
                <th>Account</th>
                <th>Actor</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {links.length === 0 ? (
                <tr>
                  <td colSpan={5} class="control-empty-cell">No linked identities.</td>
                </tr>
              ) : links.map((link) => (
                <tr key={`${link.adapter}:${link.accountId}:${link.actorId}`}>
                  <td><span class="control-pill">{link.adapter}</span></td>
                  <td><code>{link.accountId}</code></td>
                  <td><code>{link.actorId}</code></td>
                  <td>{formatDate(link.createdAt)}</td>
                  <td class="control-actions-cell">
                    <button
                      class="control-button control-button--danger"
                      disabled={pendingAction === `unlink:${link.adapter}:${link.accountId}:${link.actorId}`}
                      onClick={() => {
                        if (!window.confirm(`Unlink ${link.adapter}:${link.accountId}?`)) {
                          return;
                        }
                        void onUnlink(link);
                      }}
                    >
                      {pendingAction === `unlink:${link.adapter}:${link.accountId}:${link.actorId}` ? "Removing…" : "Unlink"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}
