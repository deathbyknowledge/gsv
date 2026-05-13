import { useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import {
  AI_FIELDS,
  PROFILE_CONTEXT_FIELDS,
  PROFILE_OPTIONS,
  buildProfileApprovalKey,
  buildProfileContextKey,
  buildUserAiOverrideKey,
} from "./config-schema";
import {
  buildDrafts,
  formatDate,
  isWideField,
  serializeConfigValue,
  settingFieldsForRuntime,
  summarizeValue,
  unmodeledEntries,
} from "./settings-domain";
import type {
  AccessToken,
  AdministrationMode,
  AdministrationState,
  ConfigEntry,
  CreatedAccessToken,
  IdentityLink,
  ProfileId,
  SaveConfigEntry,
  SettingField,
  SettingsPanelId,
  TokenKind,
} from "./types";
import { linkActionId, useAdministration } from "./useAdministration";

const TOKEN_KINDS: TokenKind[] = ["user", "service", "node"];

export function AdministrationSection({
  backend,
  mode,
}: {
  backend: GsvBackend;
  mode: AdministrationMode;
}) {
  const runtime = useAdministration(backend);

  return (
    <section class="gsv-admin">
      <header class="gsv-admin-toolbar">
        <div>
          <span class="gsv-kicker">Administration</span>
          <h3>{mode === "access" ? "Access" : "Settings"}</h3>
          <p>{mode === "access" ? "Credentials, linked identities, and authorization posture." : "Curated runtime configuration with raw recovery controls."}</p>
        </div>
        <button class="gsv-mini-button" type="button" disabled={runtime.pendingAction === "load-state"} onClick={() => void runtime.refresh()}>
          {runtime.pendingAction === "load-state" ? "Refreshing" : "Refresh"}
        </button>
      </header>

      {runtime.errorText ? <p class="gsv-inline-error">{runtime.errorText}</p> : null}

      {!runtime.state ? (
        <section class="gsv-admin-panel">
          <div class="gsv-empty-state"><h3>Loading</h3><p>Fetching administration state...</p></div>
        </section>
      ) : mode === "access" ? (
        <AccessView
          state={runtime.state}
          issuedToken={runtime.issuedToken}
          pendingAction={runtime.pendingAction}
          onCreateToken={runtime.createToken}
          onRevokeToken={(token) => runtime.revokeToken({ tokenId: token.tokenId, reason: "access revoked" })}
          onConsumeCode={(code) => runtime.consumeLinkCode({ code })}
          onCreateLink={(link) => runtime.createLink(link)}
          onRemoveLink={(link) => runtime.removeLink(link)}
        />
      ) : (
        <SettingsView
          state={runtime.state}
          pendingAction={runtime.pendingAction}
          onSave={(actionId, entries) => runtime.saveConfig({ entries }, actionId)}
          onClientError={runtime.setErrorText}
        />
      )}
    </section>
  );
}

function AccessView({
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
  onCreateToken: (args: { kind: TokenKind; label?: string; allowedDeviceId?: string; expiresAt?: number | null }) => Promise<void>;
  onRevokeToken: (token: AccessToken) => void;
  onConsumeCode: (code: string) => void;
  onCreateLink: (link: { adapter: string; accountId: string; actorId: string }) => void;
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
          <button class="gsv-action-button" type="button" disabled={pendingAction === "create-token"} onClick={() => void onCreateToken({
            kind: tokenForm.kind,
            label: tokenForm.label,
            allowedDeviceId: tokenForm.allowedDeviceId,
            expiresAt: tokenForm.expiresAt ? new Date(tokenForm.expiresAt).getTime() : null,
          })}>
            {pendingAction === "create-token" ? "Issuing" : "Issue token"}
          </button>
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
          <button class="gsv-mini-button" type="button" disabled={pendingAction === "consume-link"} onClick={() => {
            onConsumeCode(code);
            setCode("");
          }}>
            {pendingAction === "consume-link" ? "Redeeming" : "Redeem"}
          </button>
        </div>

        <div class="gsv-admin-form-grid">
          <label><span>Adapter</span><input placeholder="discord" value={manualLink.adapter} onInput={(event) => setManualLink((current) => ({ ...current, adapter: event.currentTarget.value }))} /></label>
          <label><span>Account</span><input value={manualLink.accountId} onInput={(event) => setManualLink((current) => ({ ...current, accountId: event.currentTarget.value }))} /></label>
          <label><span>Actor</span><input value={manualLink.actorId} onInput={(event) => setManualLink((current) => ({ ...current, actorId: event.currentTarget.value }))} /></label>
        </div>
        <div class="gsv-admin-actions">
          <button class="gsv-mini-button" type="button" disabled={pendingAction === "create-link"} onClick={() => {
            onCreateLink(manualLink);
            setManualLink({ adapter: "", accountId: "", actorId: "" });
          }}>
            {pendingAction === "create-link" ? "Creating" : "Create link"}
          </button>
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
            <button class="gsv-mini-button is-danger" type="button" disabled={revoked || pendingAction === `revoke:${token.tokenId}`} onClick={() => {
              if (!window.confirm(`Revoke token ${token.tokenPrefix}?`)) return;
              onRevoke(token);
            }}>
              {revoked ? "Revoked" : pendingAction === `revoke:${token.tokenId}` ? "Revoking" : "Revoke"}
            </button>
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
          <button class="gsv-mini-button is-danger" type="button" disabled={pendingAction === linkActionId(link)} onClick={() => {
            if (!window.confirm(`Unlink ${link.adapter}:${link.accountId}?`)) return;
            onRemove(link);
          }}>
            {pendingAction === linkActionId(link) ? "Removing" : "Unlink"}
          </button>
        </article>
      ))}
    </div>
  );
}

function SettingsView({
  state,
  pendingAction,
  onSave,
  onClientError,
}: {
  state: AdministrationState;
  pendingAction: string | null;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
  onClientError: (message: string | null) => void;
}) {
  const [panel, setPanel] = useState<SettingsPanelId>("ai");
  const [profile, setProfile] = useState<ProfileId>("task");
  const initialDrafts = useMemo(() => buildDrafts(state.configValues), [state.configValues]);
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);

  useEffect(() => {
    setDrafts(initialDrafts);
  }, [initialDrafts]);

  function updateDraft(key: string, value: string): void {
    setDrafts((current) => ({ ...current, [key]: value }));
  }

  function resetKeys(keys: string[]): void {
    setDrafts((current) => {
      const next = { ...current };
      for (const key of keys) {
        if (initialDrafts[key] !== undefined) {
          next[key] = initialDrafts[key];
        } else {
          delete next[key];
        }
      }
      return next;
    });
  }

  async function saveEntries(actionId: string, entries: SaveConfigEntry[]): Promise<void> {
    await onSave(actionId, entries.map((entry) => ({
      key: entry.key,
      value: serializeConfigValue(entry.key, entry.value),
    })));
  }

  return (
    <section class="gsv-admin-settings">
      <aside class="gsv-admin-nav" aria-label="Settings sections">
        {([
          ["ai", "AI", "Provider, model, keys, and personal overrides"],
          ["profiles", "Profiles", "Runtime context and tool approval policy"],
          ["runtime", "Runtime", "Shell, server, process, and automation settings"],
          ["advanced", "Advanced", "Raw config for recovery and unmodeled keys"],
        ] as Array<[SettingsPanelId, string, string]>).map(([id, label, description]) => (
          <button key={id} type="button" class={panel === id ? "is-active" : ""} onClick={() => setPanel(id)}>
            <strong>{label}</strong>
            <span>{description}</span>
          </button>
        ))}
      </aside>

      {panel === "ai" ? (
        <SettingsForm
          title="AI defaults"
          description="Root edits system defaults. Non-root users save personal AI overrides."
          fields={AI_FIELDS}
          values={state.configValues}
          viewer={state.viewer}
          drafts={drafts}
          initialDrafts={initialDrafts}
          pendingAction={pendingAction}
          overrideAiForUser={!state.viewer.canEditSystemConfig}
          onChange={updateDraft}
          onReset={resetKeys}
          onSave={saveEntries}
        />
      ) : panel === "profiles" ? (
        <ProfilesForm
          values={state.configValues}
          viewer={state.viewer}
          drafts={drafts}
          initialDrafts={initialDrafts}
          selectedProfile={profile}
          pendingAction={pendingAction}
          onProfile={setProfile}
          onChange={updateDraft}
          onReset={resetKeys}
          onSave={saveEntries}
        />
      ) : panel === "runtime" ? (
        <SettingsForm
          title="Runtime behavior"
          description="Operational limits and runtime metadata. Root access is required to change these settings."
          fields={settingFieldsForRuntime()}
          values={state.configValues}
          viewer={state.viewer}
          drafts={drafts}
          initialDrafts={initialDrafts}
          pendingAction={pendingAction}
          overrideAiForUser={false}
          onChange={updateDraft}
          onReset={resetKeys}
          onSave={saveEntries}
        />
      ) : (
        <AdvancedConfig
          entries={state.configEntries}
          viewer={state.viewer}
          pendingAction={pendingAction}
          onSave={saveEntries}
          onClientError={onClientError}
        />
      )}
    </section>
  );
}

function SettingsForm({
  title,
  description,
  fields,
  values,
  viewer,
  drafts,
  initialDrafts,
  pendingAction,
  overrideAiForUser,
  onChange,
  onReset,
  onSave,
}: {
  title: string;
  description: string;
  fields: SettingField[];
  values: Record<string, string>;
  viewer: AdministrationState["viewer"];
  drafts: Record<string, string>;
  initialDrafts: Record<string, string>;
  pendingAction: string | null;
  overrideAiForUser: boolean;
  onChange: (key: string, value: string) => void;
  onReset: (keys: string[]) => void;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
}) {
  const rows = fields.map((field) => {
    const editableKey = overrideAiForUser ? buildUserAiOverrideKey(viewer.uid, field.key) : field.key;
    const systemValue = initialDrafts[field.key] ?? "";
    const fallback = overrideAiForUser ? systemValue : initialDrafts[editableKey] ?? systemValue;
    const value = drafts[editableKey] ?? initialDrafts[editableKey] ?? fallback;
    const baseline = initialDrafts[editableKey] ?? fallback;
    const disabled = (!viewer.canEditSystemConfig && !overrideAiForUser) || field.kind === "readonly";
    const hasOverride = overrideAiForUser && values[editableKey] !== undefined;
    const note = overrideAiForUser
      ? (hasOverride ? "Personal override active." : `Using system default: ${summarizeValue(systemValue)}`)
      : !viewer.canEditSystemConfig && field.kind !== "readonly"
        ? "Only root can edit this system setting."
        : null;
    return { field, editableKey, value, baseline, disabled, note, dirty: value !== baseline };
  });
  const editableRows = rows.filter((row) => !row.disabled && row.field.kind !== "readonly");
  const dirty = editableRows.some((row) => row.dirty);
  const actionId = `save:${title}`;

  return (
    <section class="gsv-admin-panel">
      <header class="gsv-admin-panel-head">
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </header>
      <div class="gsv-admin-settings-grid">
        {rows.map((row) => (
          <SettingBlock key={row.editableKey} row={row} onChange={onChange} />
        ))}
      </div>
      {editableRows.length > 0 ? (
        <div class="gsv-admin-actions">
          <span>{dirty ? "Unsaved changes" : "No changes"}</span>
          <button class="gsv-mini-button" type="button" disabled={!dirty || pendingAction === actionId} onClick={() => onReset(editableRows.map((row) => row.editableKey))}>Reset</button>
          <button class="gsv-action-button" type="button" disabled={!dirty || pendingAction === actionId} onClick={() => void onSave(actionId, editableRows.map((row) => ({ key: row.editableKey, value: row.value })))}>{pendingAction === actionId ? "Saving" : "Save changes"}</button>
        </div>
      ) : null}
    </section>
  );
}

function ProfilesForm({
  values,
  viewer,
  drafts,
  initialDrafts,
  selectedProfile,
  pendingAction,
  onProfile,
  onChange,
  onReset,
  onSave,
}: {
  values: Record<string, string>;
  viewer: AdministrationState["viewer"];
  drafts: Record<string, string>;
  initialDrafts: Record<string, string>;
  selectedProfile: ProfileId;
  pendingAction: string | null;
  onProfile: (profile: ProfileId) => void;
  onChange: (key: string, value: string) => void;
  onReset: (keys: string[]) => void;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
}) {
  const fields = [
    ...PROFILE_CONTEXT_FIELDS.map((field) => ({
      label: field.label,
      description: field.description,
      rows: field.rows,
      key: buildProfileContextKey(selectedProfile, field.file),
    })),
    {
      label: "Tool approval policy",
      description: "Ordered approval rules for the selected profile. Stored as JSON.",
      rows: 10,
      key: buildProfileApprovalKey(selectedProfile),
    },
  ];
  const rows = fields.map((field) => {
    const editableKey = viewer.canEditSystemConfig ? field.key : buildUserAiOverrideKey(viewer.uid, field.key);
    const systemValue = initialDrafts[field.key] ?? "";
    const value = drafts[editableKey] ?? initialDrafts[editableKey] ?? systemValue;
    const baseline = initialDrafts[editableKey] ?? systemValue;
    return {
      field: { ...field, kind: "textarea" as const },
      editableKey,
      value,
      baseline,
      dirty: value !== baseline,
      disabled: false,
      note: viewer.canEditSystemConfig
        ? null
        : values[editableKey] !== undefined
          ? "Personal override active."
          : `Using system default: ${summarizeValue(systemValue)}`,
    };
  });
  const dirty = rows.some((row) => row.dirty);
  const actionId = `save:profile:${selectedProfile}`;

  return (
    <section class="gsv-admin-panel">
      <header class="gsv-admin-panel-head">
        <div>
          <h4>Profiles</h4>
          <p>Edit prompt context and approval policy that shape each runtime profile.</p>
        </div>
      </header>
      <div class="gsv-admin-profile-strip">
        {PROFILE_OPTIONS.map((profile) => (
          <button key={profile.id} type="button" class={profile.id === selectedProfile ? "is-active" : ""} onClick={() => onProfile(profile.id)}>
            <strong>{profile.label}</strong>
            <span>{profile.description}</span>
          </button>
        ))}
      </div>
      <div class="gsv-admin-editor-stack">
        {rows.map((row) => (
          <SettingBlock key={row.editableKey} row={row} onChange={onChange} />
        ))}
      </div>
      <div class="gsv-admin-actions">
        <span>{dirty ? "Unsaved changes" : "No changes"}</span>
        <button class="gsv-mini-button" type="button" disabled={!dirty || pendingAction === actionId} onClick={() => onReset(rows.map((row) => row.editableKey))}>Reset</button>
        <button class="gsv-action-button" type="button" disabled={!dirty || pendingAction === actionId} onClick={() => void onSave(actionId, rows.map((row) => ({ key: row.editableKey, value: row.value })))}>{pendingAction === actionId ? "Saving" : "Save changes"}</button>
      </div>
    </section>
  );
}

function AdvancedConfig({
  entries,
  viewer,
  pendingAction,
  onSave,
  onClientError,
}: {
  entries: ConfigEntry[];
  viewer: AdministrationState["viewer"];
  pendingAction: string | null;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
  onClientError: (message: string | null) => void;
}) {
  const editableEntries = useMemo(
    () => viewer.canEditSystemConfig ? entries : entries.filter((entry) => entry.key.startsWith(viewer.userAiPrefix)),
    [entries, viewer],
  );
  const initialDraft = useMemo(
    () => JSON.stringify(Object.fromEntries(editableEntries.map((entry) => [entry.key, entry.value])), null, 2),
    [editableEntries],
  );
  const [draft, setDraft] = useState(initialDraft);
  const extraEntries = unmodeledEntries(entries);

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  function apply(): void {
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      const nextEntries = Object.entries(parsed).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
      }));
      if (!viewer.canEditSystemConfig) {
        const invalid = nextEntries.find((entry) => !entry.key.startsWith(viewer.userAiPrefix));
        if (invalid) {
          throw new Error(`Only ${viewer.userAiPrefix}* keys are editable for ${viewer.username}`);
        }
      }
      onClientError(null);
      void onSave("save:advanced", nextEntries);
    } catch (error) {
      onClientError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section class="gsv-admin-panel">
      <header class="gsv-admin-panel-head">
        <div>
          <h4>{viewer.canEditSystemConfig ? "Advanced config" : "Advanced personal overrides"}</h4>
          <p>{viewer.canEditSystemConfig ? "Raw config editing for unmodeled keys, recovery, and debugging." : `Raw personal AI overrides under ${viewer.userAiPrefix}*.`}</p>
        </div>
      </header>
      {extraEntries.length > 0 ? (
        <p class="gsv-admin-note">{extraEntries.length} visible key{extraEntries.length === 1 ? "" : "s"} are not modeled by the curated settings panels.</p>
      ) : null}
      <textarea class="gsv-admin-raw" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} />
      <div class="gsv-admin-actions">
        <button class="gsv-action-button" type="button" disabled={pendingAction === "save:advanced"} onClick={apply}>{pendingAction === "save:advanced" ? "Applying" : "Apply raw updates"}</button>
        <button class="gsv-mini-button" type="button" disabled={pendingAction === "save:advanced"} onClick={() => setDraft(initialDraft)}>Reset</button>
      </div>
    </section>
  );
}

type SettingRow = {
  field: SettingField;
  editableKey: string;
  value: string;
  disabled: boolean;
  note: string | null;
};

function SettingBlock({ row, onChange }: { row: SettingRow; onChange: (key: string, value: string) => void }) {
  return (
    <div class={`gsv-admin-setting${isWideField(row.field) ? " is-wide" : ""}`}>
      <label>{row.field.label}</label>
      <p>{row.field.description}</p>
      <SettingInput row={row} onChange={(value) => onChange(row.editableKey, value)} />
      {row.note ? <span class="gsv-admin-field-note">{row.note}</span> : null}
    </div>
  );
}

function SettingInput({ row, onChange }: { row: SettingRow; onChange: (value: string) => void }) {
  const field = row.field;
  if (field.kind === "textarea" || field.kind === "json") {
    return <textarea rows={field.rows ?? 6} value={row.value} disabled={row.disabled} placeholder={field.placeholder} onInput={(event) => onChange(event.currentTarget.value)} />;
  }
  if (field.kind === "select") {
    return (
      <select value={row.value} disabled={row.disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  if (field.kind === "checkbox") {
    return (
      <label class="gsv-admin-toggle">
        <input type="checkbox" checked={row.value === "true"} disabled={row.disabled} onInput={(event) => onChange(event.currentTarget.checked ? "true" : "false")} />
        <span>{row.value === "true" ? "Enabled" : "Disabled"}</span>
      </label>
    );
  }
  if (field.kind === "readonly") {
    return <div class="gsv-admin-readonly">{row.value || "not set"}</div>;
  }
  return <input type={field.kind === "number" ? "number" : field.kind === "password" ? "password" : "text"} value={row.value} disabled={row.disabled} placeholder={field.placeholder} onInput={(event) => onChange(event.currentTarget.value)} />;
}
