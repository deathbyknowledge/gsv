import type { DeviceDetail, DeviceToken, DevicesViewer } from "./types";

type DeviceAccessProps = {
  viewer: DevicesViewer;
  device: DeviceDetail;
  tokens: DeviceToken[];
  pendingAction: string | null;
  onProvision: (deviceId: string) => void;
  onRevoke: (tokenId: string) => void;
};

export function DeviceAccess({ viewer, device, tokens, pendingAction, onProvision, onRevoke }: DeviceAccessProps) {
  return (
    <section class="devices-detail-section">
      <div class="devices-access-head">
        {viewer.canManageTokens ? (
          <button class="devices-button devices-button--primary" onClick={() => onProvision(device.deviceId)}>
            Issue node token
          </button>
        ) : null}
      </div>

      <div class="devices-detail-table-wrap devices-access-table-wrap">
        <table class="devices-detail-table devices-access-table">
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th>Status</th>
              {viewer.canManageTokens ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 ? (
              <tr>
                <td colSpan={viewer.canManageTokens ? 7 : 6} class="devices-empty-cell">No node tokens issued for this device.</td>
              </tr>
            ) : tokens.map((token) => {
              const revoked = typeof token.revokedAt === "number";
              return (
                <tr key={token.tokenId}>
                  <td class="is-mono">{token.tokenPrefix}</td>
                  <td>{token.label || device.deviceId}</td>
                  <td>{formatTimestamp(token.createdAt)}</td>
                  <td>{formatNullableTimestamp(token.lastUsedAt)}</td>
                  <td>{formatNullableTimestamp(token.expiresAt)}</td>
                  <td>{revoked ? "Revoked" : "Active"}</td>
                  {viewer.canManageTokens ? (
                    <td class="devices-actions-cell">
                      {!revoked ? (
                        <button
                          class="devices-button devices-button--quiet"
                          disabled={pendingAction === `revoke:${token.tokenId}`}
                          onClick={() => onRevoke(token.tokenId)}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div class="devices-access-cards" role="list">
        {tokens.length === 0 ? (
          <div class="devices-empty-list">No node tokens issued for this device.</div>
        ) : tokens.map((token) => {
          const revoked = typeof token.revokedAt === "number";
          return (
            <article key={token.tokenId} class="devices-access-card" role="listitem">
              <header>
                <div>
                  <span>Prefix</span>
                  <strong class="is-mono">{token.tokenPrefix}</strong>
                </div>
                <span class={`devices-status-pill${revoked ? " is-offline" : " is-online"}`}>
                  {revoked ? "revoked" : "active"}
                </span>
              </header>
              <dl>
                <div>
                  <dt>Label</dt>
                  <dd>{token.label || device.deviceId}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatTimestamp(token.createdAt)}</dd>
                </div>
                <div>
                  <dt>Last used</dt>
                  <dd>{formatNullableTimestamp(token.lastUsedAt)}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{formatNullableTimestamp(token.expiresAt)}</dd>
                </div>
              </dl>
              {viewer.canManageTokens && !revoked ? (
                <button
                  class="devices-button devices-button--quiet"
                  disabled={pendingAction === `revoke:${token.tokenId}`}
                  onClick={() => onRevoke(token.tokenId)}
                >
                  Revoke token
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatNullableTimestamp(timestamp: number | null): string {
  return typeof timestamp === "number" ? formatTimestamp(timestamp) : "—";
}
