import { FormEvent, useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { useReactUiStore } from "../state/store";

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function channelIcon(channel: string): string {
  if (channel.includes("whatsapp")) return "📱";
  if (channel.includes("discord")) return "🎮";
  return "🔗";
}

function statusBadge(status: string) {
  if (status === "active") {
    return <Badge variant="primary">active</Badge>;
  }
  if (status === "claimed") {
    return <Badge variant="outline">claimed</Badge>;
  }
  if (status === "expired") {
    return <Badge variant="destructive">expired</Badge>;
  }
  return <Badge variant="outline">revoked</Badge>;
}

export function PairingView() {
  const pairingRequests = useReactUiStore((s) => s.pairingRequests);
  const pairingLoading = useReactUiStore((s) => s.pairingLoading);
  const loadPairing = useReactUiStore((s) => s.loadPairing);
  const pairApprove = useReactUiStore((s) => s.pairApprove);
  const pairReject = useReactUiStore((s) => s.pairReject);

  const invites = useReactUiStore((s) => s.invites);
  const invitesLoading = useReactUiStore((s) => s.invitesLoading);
  const loadInvites = useReactUiStore((s) => s.loadInvites);
  const createInvite = useReactUiStore((s) => s.createInvite);
  const revokeInvite = useReactUiStore((s) => s.revokeInvite);
  const claimInvite = useReactUiStore((s) => s.claimInvite);

  const [includeInactive, setIncludeInactive] = useState(false);
  const [createdInviteCode, setCreatedInviteCode] = useState<string | null>(null);

  const [homeSpaceId, setHomeSpaceId] = useState("default");
  const [role, setRole] = useState("member");
  const [homeAgentId, setHomeAgentId] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [principalId, setPrincipalId] = useState("");

  const [claimCode, setClaimCode] = useState("");
  const [claimPrincipalId, setClaimPrincipalId] = useState("");
  const [claimChannel, setClaimChannel] = useState("");
  const [claimAccountId, setClaimAccountId] = useState("default");
  const [claimSenderId, setClaimSenderId] = useState("");

  const activeInvites = useMemo(
    () => invites.filter((invite) => invite.status === "active"),
    [invites],
  );

  async function refreshAll() {
    await Promise.all([
      loadPairing(),
      loadInvites({ includeInactive }),
    ]);
  }

  async function handleCreateInvite(event: FormEvent) {
    event.preventDefault();
    const normalizedHomeSpaceId = homeSpaceId.trim();
    if (!normalizedHomeSpaceId) {
      alert("Home space is required.");
      return;
    }

    const parsedTtlMinutes = ttlMinutes.trim()
      ? Number.parseInt(ttlMinutes.trim(), 10)
      : undefined;
    if (
      parsedTtlMinutes !== undefined &&
      (!Number.isFinite(parsedTtlMinutes) || parsedTtlMinutes <= 0)
    ) {
      alert("TTL minutes must be a positive integer.");
      return;
    }

    try {
      const invite = await createInvite({
        homeSpaceId: normalizedHomeSpaceId,
        role: role.trim() || "member",
        homeAgentId: homeAgentId.trim() || undefined,
        ttlMinutes: parsedTtlMinutes,
        code: inviteCode.trim() || undefined,
        principalId: principalId.trim() || undefined,
      });
      setCreatedInviteCode(invite.code);
      setInviteCode("");
      setPrincipalId("");
      await loadInvites({ includeInactive });
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleClaimInvite(event: FormEvent) {
    event.preventDefault();
    if (!claimCode.trim()) {
      alert("Invite code is required.");
      return;
    }
    if (!claimPrincipalId.trim() && !(claimChannel.trim() && claimSenderId.trim())) {
      alert("Provide principalId, or channel + senderId.");
      return;
    }

    try {
      await claimInvite({
        code: claimCode.trim(),
        principalId: claimPrincipalId.trim() || undefined,
        channel: claimChannel.trim() || undefined,
        accountId: claimAccountId.trim() || undefined,
        senderId: claimSenderId.trim() || undefined,
      });
      setClaimCode("");
      alert("Invite claimed successfully.");
      await refreshAll();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="view-container" style={{ display: "grid", gap: "var(--space-5)" }}>
      <div className="section-header">
        <span className="section-title">Pairing and Onboarding</span>
        <Button
          size="sm"
          variant="secondary"
          loading={pairingLoading || invitesLoading}
          onClick={() => {
            void refreshAll();
          }}
        >
          Refresh
        </Button>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Pending Pairing Requests</span>
        </div>
        <div className="card-body">
          {pairingLoading && !pairingRequests.length ? (
            <div className="empty-state">
              <span className="spinner"></span> Loading...
            </div>
          ) : !pairingRequests.length ? (
            <div className="empty-state" style={{ padding: 0 }}>
              <div className="empty-state-description">
                No pending requests right now.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              {pairingRequests.map((pair) => (
                <div className="card" key={`${pair.channel}:${pair.senderId}`}>
                  <div className="card-header">
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <span style={{ fontSize: "1.5rem" }}>{channelIcon(pair.channel)}</span>
                      <div>
                        <div className="card-title">{pair.senderName || pair.senderId}</div>
                        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--text-muted)" }}>
                          {pair.channel} - {pair.senderId}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "var(--space-2)" }}>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          void pairApprove(pair.channel, pair.senderId);
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (
                            confirm(
                              `Reject pairing request from ${pair.senderName || pair.senderId}?`,
                            )
                          ) {
                            void pairReject(pair.channel, pair.senderId);
                          }
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                  <div className="card-body">
                    <div className="kv-list">
                      <div className="kv-row">
                        <span className="kv-key">Requested</span>
                        <span className="kv-value">{relativeTime(pair.requestedAt)}</span>
                      </div>
                      {pair.message ? (
                        <div className="kv-row">
                          <span className="kv-key">Message</span>
                          <span className="kv-value">{pair.message}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Create Invite</span>
        </div>
        <div className="card-body">
          <form onSubmit={(event) => void handleCreateInvite(event)}>
            <div className="form-group">
              <Input
                label="Home Space ID"
                className="ui-input-fix"
                size="lg"
                value={homeSpaceId}
                onChange={(event) => setHomeSpaceId(event.target.value)}
                placeholder="default"
              />
            </div>
            <div className="form-group">
              <Input
                label="Role"
                className="ui-input-fix"
                size="lg"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="member"
              />
            </div>
            <div className="form-group">
              <Input
                label="Home Agent ID (optional)"
                className="ui-input-fix"
                size="lg"
                value={homeAgentId}
                onChange={(event) => setHomeAgentId(event.target.value)}
                placeholder="main"
              />
            </div>
            <div className="form-group">
              <Input
                label="TTL Minutes (optional)"
                className="ui-input-fix"
                size="lg"
                type="number"
                value={ttlMinutes}
                onChange={(event) => setTtlMinutes(event.target.value)}
                placeholder="1440"
              />
            </div>
            <div className="form-group">
              <Input
                label="Invite Code (optional, auto-generated if empty)"
                className="ui-input-fix mono"
                size="lg"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="JOIN1234"
              />
            </div>
            <div className="form-group">
              <Input
                label="Principal Restriction (optional)"
                className="ui-input-fix"
                size="lg"
                value={principalId}
                onChange={(event) => setPrincipalId(event.target.value)}
                placeholder="channel:whatsapp:default:+15551234567"
              />
            </div>

            <Button type="submit" variant="primary" loading={invitesLoading}>
              Create Invite
            </Button>

            {createdInviteCode ? (
              <p style={{ marginTop: "var(--space-3)" }}>
                Created invite code: <code className="mono">{createdInviteCode}</code>
              </p>
            ) : null}
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-header" style={{ alignItems: "center" }}>
          <span className="card-title">Invites</span>
          <Checkbox
            label="Show inactive"
            checked={includeInactive}
            onCheckedChange={(checked) => {
              const next = Boolean(checked);
              setIncludeInactive(next);
              void loadInvites({ includeInactive: next });
            }}
          />
        </div>
        <div className="card-body">
          {invitesLoading && !invites.length ? (
            <div className="empty-state">
              <span className="spinner"></span> Loading invites...
            </div>
          ) : !invites.length ? (
            <div className="empty-state" style={{ padding: 0 }}>
              <div className="empty-state-description">No invites found.</div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              {invites.map((invite) => (
                <div className="card" key={invite.inviteId}>
                  <div className="card-header">
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <code className="mono">{invite.code}</code>
                      {statusBadge(invite.status)}
                    </div>
                    {invite.status === "active" ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (confirm(`Revoke invite ${invite.code}?`)) {
                            void revokeInvite(invite.inviteId);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                  <div className="card-body">
                    <div className="kv-list">
                      <div className="kv-row">
                        <span className="kv-key">Space</span>
                        <span className="kv-value">{invite.homeSpaceId}</span>
                      </div>
                      <div className="kv-row">
                        <span className="kv-key">Role</span>
                        <span className="kv-value">{invite.role}</span>
                      </div>
                      {invite.homeAgentId ? (
                        <div className="kv-row">
                          <span className="kv-key">Home Agent</span>
                          <span className="kv-value">{invite.homeAgentId}</span>
                        </div>
                      ) : null}
                      {invite.principalId ? (
                        <div className="kv-row">
                          <span className="kv-key">Principal Restriction</span>
                          <span className="kv-value mono">{invite.principalId}</span>
                        </div>
                      ) : null}
                      <div className="kv-row">
                        <span className="kv-key">Created</span>
                        <span className="kv-value">{relativeTime(invite.createdAt)}</span>
                      </div>
                      {invite.expiresAt ? (
                        <div className="kv-row">
                          <span className="kv-key">Expires</span>
                          <span className="kv-value">{relativeTime(invite.expiresAt)}</span>
                        </div>
                      ) : null}
                      {invite.claimedBy ? (
                        <div className="kv-row">
                          <span className="kv-key">Claimed By</span>
                          <span className="kv-value mono">{invite.claimedBy}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Claim Invite</span>
        </div>
        <div className="card-body">
          <form onSubmit={(event) => void handleClaimInvite(event)}>
            <div className="form-group">
              <Input
                label="Invite Code"
                className="ui-input-fix mono"
                size="lg"
                value={claimCode}
                onChange={(event) => setClaimCode(event.target.value)}
                placeholder="JOIN1234"
              />
            </div>
            <div className="form-group">
              <Input
                label="Principal ID (optional if channel+sender provided)"
                className="ui-input-fix"
                size="lg"
                value={claimPrincipalId}
                onChange={(event) => setClaimPrincipalId(event.target.value)}
                placeholder="channel:whatsapp:default:+15551234567"
              />
            </div>
            <div className="cards-grid" style={{ marginBottom: "var(--space-3)" }}>
              <div className="form-group">
                <Input
                  label="Channel (optional)"
                  className="ui-input-fix"
                  size="lg"
                  value={claimChannel}
                  onChange={(event) => setClaimChannel(event.target.value)}
                  placeholder="whatsapp"
                />
              </div>
              <div className="form-group">
                <Input
                  label="Account ID"
                  className="ui-input-fix"
                  size="lg"
                  value={claimAccountId}
                  onChange={(event) => setClaimAccountId(event.target.value)}
                  placeholder="default"
                />
              </div>
              <div className="form-group">
                <Input
                  label="Sender ID (optional)"
                  className="ui-input-fix"
                  size="lg"
                  value={claimSenderId}
                  onChange={(event) => setClaimSenderId(event.target.value)}
                  placeholder="+15551234567"
                />
              </div>
            </div>

            <Button type="submit" variant="secondary" loading={invitesLoading}>
              Claim Invite
            </Button>
          </form>
        </div>
      </div>

      {activeInvites.length > 0 ? (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Quick Copy Active Codes</span>
          </div>
          <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {activeInvites.map((invite) => (
              <button
                key={`copy-${invite.inviteId}`}
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(invite.code);
                }}
                title="Copy invite code"
                style={{
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--surface-elevated)",
                  color: "var(--text-primary)",
                  padding: "var(--space-2) var(--space-3)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                {invite.code}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
