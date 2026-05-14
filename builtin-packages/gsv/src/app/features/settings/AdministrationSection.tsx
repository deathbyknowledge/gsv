import type { GsvBackend } from "../../backend-contract";
import { ActionButton } from "../../components/ui/ActionButton";
import { AccessView } from "./AccessAdministration";
import { SettingsView } from "./SettingsAdministration";
import type { AdministrationMode } from "./types";
import { useAdministration } from "./useAdministration";

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
        <ActionButton
          icon="refresh"
          label="Refresh"
          busyLabel="Refreshing"
          busy={runtime.pendingAction === "load-state"}
          size="icon"
          onClick={() => void runtime.refresh()}
        />
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
