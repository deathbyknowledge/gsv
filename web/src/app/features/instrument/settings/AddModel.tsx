import { useQuery, useQueryClient } from "@tanstack/preact-query";
import { useMemo, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  checkConsoleOpenAiCodexOAuth,
  loadConsoleTargets,
  pollConsoleOpenAiCodexOAuth,
  saveConsoleConfigEntries,
  startConsoleOpenAiCodexOAuth,
  validateConsoleModelConfig,
} from "../../gsv-console/backend/consoleService";
import type { ConsoleAccount, ConsoleConfigEntry } from "../../gsv-console/domain/consoleModels";
import {
  createModelProfile,
  editableModelSource,
  effectiveAiValuesForViewer,
  makeModelPrimary,
  modelProfilesFromListing,
  modelProfileSaveEntries,
  preferredModelSaveEntry,
  writableModelProfiles,
  type ConsoleModelListing,
} from "../../gsv-console/domain/consoleSettings";
import { ModelProfileForm } from "../../gsv-console/pages/ConsoleConfigPage";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { canConfigure, SETTINGS_CONFIG_KEY, SETTINGS_MODELS_KEY } from "./settingsModel";

export function AddModel({ account, config, models, active, onDirty, onCancel, onAdded }: {
  account: ConsoleAccount;
  config: readonly ConsoleConfigEntry[];
  models: ConsoleModelListing;
  active: boolean;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const targets = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected && active });
  const profiles = useMemo(() => modelProfilesFromListing(models, config, account.uid), [models, config, account.uid]);
  const defaults = useMemo(() => effectiveAiValuesForViewer(config, account.uid, profiles[0] ?? null), [config, account.uid, profiles]);
  return <div class="settings-model-editor">
    <h2>Add model</h2>
    <p class="settings-muted">{step + 1} of 4 · {["type", "name", "connection", "options"][step]}</p>
    {targets.isPending && connected && <LoadingState>Loading places…</LoadingState>}
    {targets.error && <p class="settings-error" role="alert">Could not load places: {targets.error.message}</p>}
    <ModelProfileForm
      config={config}
      defaultValues={defaults}
      editable={connected && canConfigure(account, "sys.config.set") && !targets.isPending && !targets.isError}
      profile={null}
      profiles={profiles}
      targets={(targets.data ?? []).map((target) => ({ id: target.deviceId, label: target.label || target.deviceId, online: target.online, implements: target.implements }))}
      viewer={{ account, uid: account.uid, isRoot: account.uid === 0 }}
      step={step}
      onStepChange={setStep}
      onDirtyChange={onDirty}
      onCancel={onCancel}
      onCheckOpenAiCodexOAuth={async () => (await checkConsoleOpenAiCodexOAuth(client)).connected}
      onStartOpenAiCodexOAuth={async () => {
        const result = await startConsoleOpenAiCodexOAuth(client);
        return { flowId: result.flow.flowId, userCode: result.userCode, verificationUrl: result.verificationUrl, intervalSeconds: result.intervalSeconds, expiresAt: result.expiresAt };
      }}
      onPollOpenAiCodexOAuth={async (flowId) => {
        const result = await pollConsoleOpenAiCodexOAuth(client, { flowId });
        return result.status === "complete" ? { status: "complete" } : { status: "pending", intervalSeconds: result.intervalSeconds, expiresAt: result.expiresAt };
      }}
      onValidate={async (input) => { await validateConsoleModelConfig(client, input); }}
      onSave={async (name, values, clearedSecrets, makeDefault) => {
        const writable = writableModelProfiles(models, config, account.uid);
        let next = createModelProfile(writable, name, values, Date.now(), editableModelSource(account.uid), profiles);
        const added = next[next.length - 1];
        if (makeDefault) next = makeModelPrimary(next, added.id);
        const entries = modelProfileSaveEntries(account.uid, next, new Map([[added.id, clearedSecrets]]));
        if (makeDefault) entries.push(preferredModelSaveEntry(account.uid, null));
        await saveConsoleConfigEntries(client, { entries });
        await Promise.all([cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }), cache.invalidateQueries({ queryKey: SETTINGS_MODELS_KEY })]);
        onDirty(false);
        onAdded();
      }}
    />
  </div>;
}
