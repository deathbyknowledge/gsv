import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { aiProviderOptionsForFeatures, fixedAiProviderModel } from "../../../domain/aiProviders";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import {
  checkConsoleOpenAiCodexOAuth,
  loadConsoleConfig,
  loadConsoleModels,
  loadConsoleTargets,
  pollConsoleOpenAiCodexOAuth,
  saveConsoleConfigEntries,
  startConsoleOpenAiCodexOAuth,
  validateConsoleModelConfig,
  type ValidateConsoleModelConfigInput,
} from "../../../services/system/consoleService";
import type { ConsoleAccount, ConsoleConfigEntry } from "../../../domain/system/consoleModels";
import {
  createModelProfile,
  editableModelSource,
  modelProfilesFromListing,
  modelProfileSecretConfigKey,
  modelProfileSaveEntries,
  modelValidationValuesFromProfileDrafts,
  preferredModelSaveEntry,
  profileValuesFromDrafts,
  writableModelProfiles,
  type ConsoleModelListing,
  type ConsoleModelProfile,
  type ConsoleConfigWrite,
} from "../../../domain/system/consoleSettings";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { canConfigure, SETTINGS_CONFIG_KEY, SETTINGS_MODELS_KEY, signInUrl } from "./settingsModel";
import { modelConnectionChanged, modelProfileChangeWrites } from "./modelProfiles";
import { rich, useT, type TextKey } from "../../../i18n/locale";

export function ModelEditor({ account, config, models, profile, active, onDirty, onCancel, onSaved }: {
  account: ConsoleAccount;
  config: readonly ConsoleConfigEntry[];
  models: ConsoleModelListing;
  profile?: ConsoleModelProfile;
  active: boolean;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const cache = useQueryClient();
  const [initial] = useState(() => ({
    profile,
    values: profileValuesFromDrafts({ ...profile?.values, "config/ai/api_key": "" }),
  }));
  const [values, setValues] = useState<Record<string, string>>(initial.values);
  const [name, setName] = useState(initial.profile?.name ?? "");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [makeFirst, setMakeFirst] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [signInError, setSignInError] = useState<TextKey | null>(null);
  const provider = values["config/ai/provider"] ?? "";
  const fixedModel = fixedAiProviderModel(provider);
  const codex = provider === "openai-codex";
  const custom = provider === "custom";
  const model = fixedModel ?? values["config/ai/model"] ?? "";
  const displayName = name.trim() || (fixedModel ? "Ship included" : model.trim().slice(0, 80));
  const profiles = modelProfilesFromListing(models, [], account.uid);
  const duplicateName = profiles.some((candidate) => candidate.id !== initial.profile?.id && candidate.name.toLowerCase() === displayName.toLowerCase());
  const connectionChanged = !!initial.profile && modelConnectionChanged(initial.values, values);
  const storedKeyPath = initial.profile ? modelProfileSecretConfigKey(account.uid, initial.profile.id, "config/ai/api_key") : null;
  const storedKey = config.find((entry) => entry.key === storedKeyPath);
  const hasStoredKey = !!storedKey && (storedKey.redacted || !!storedKey.value);
  const valuesChanged = JSON.stringify(profileValuesFromDrafts(values)) !== JSON.stringify(initial.values);
  const testRequired = !initial.profile || valuesChanged || clearApiKey;
  const providers = aiProviderOptionsForFeatures(snapshot.server?.features);
  const targets = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected && active });
  const fetchTargets = (targets.data ?? []).filter((target) => target.implements.some((capability) => capability === "net.fetch" || capability === "net.*" || capability === "*"));
  const transport = values["config/ai/transport_target"] || (codex ? "" : "gsv");
  const editable = connected && canConfigure(account, "sys.config.set");
  const oauthAccountKey = values["config/ai/oauth_account_key"] || (initial.profile?.values["config/ai/provider"] === "openai-codex" ? "default" : "");
  const auth = useQuery({ queryKey: ["instrument", "codex-sign-in", account.uid, oauthAccountKey], queryFn: () => checkConsoleOpenAiCodexOAuth(client, { uid: account.uid, accountKey: oauthAccountKey }), enabled: editable && active && codex && !!oauthAccountKey });
  const login = useMutation({
    mutationFn: (accountKey: string) => startConsoleOpenAiCodexOAuth(client, { accountKey }),
    onMutate: (accountKey) => {
      setValues((current) => ({ ...current, "config/ai/oauth_account_key": accountKey }));
      setSignedIn(false);
      setSignInError(null);
    },
  });
  const authenticated = signedIn || (auth.data?.connected === true && !login.data);
  const loginUrl = signInUrl(login.data?.verificationUrl ?? null);

  useEffect(() => {
    const flow = login.data;
    if (!active || !codex || !flow || flow.flow.accountKey !== oauthAccountKey || signedIn || signInError) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= flow.expiresAt) { setSignInError("settings.models.codeExpired"); return; }
      try {
        const result = await pollConsoleOpenAiCodexOAuth(client, { flowId: flow.flow.flowId });
        if (cancelled) return;
        if (result.status === "complete") {
          setSignedIn(true);
          void cache.invalidateQueries({ queryKey: ["instrument", "codex-sign-in"] });
        } else timer = setTimeout(() => void poll(), Math.max(1, result.intervalSeconds) * 1000);
      } catch {
        if (!cancelled) setSignInError("settings.models.signInFailed");
      }
    };
    timer = setTimeout(() => void poll(), Math.max(1, flow.intervalSeconds) * 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, codex, oauthAccountKey, login.data, signedIn, signInError, client, cache]);

  const save = useMutation({
    mutationFn: async (draft: { name: string; values: Record<string, string>; first: boolean; clearApiKey: boolean }) => {
      const cleared = new Set(draft.clearApiKey ? ["config/ai/api_key"] : []);
      if (testRequired) {
        const validation: ValidateConsoleModelConfigInput = { values: modelValidationValuesFromProfileDrafts(draft.values, cleared) };
        if (initial.profile && !connectionChanged && !draft.clearApiKey) validation.modelId = initial.profile.id;
        await validateConsoleModelConfig(client, validation);
      }
      const [latestConfig, latestModels] = await Promise.all([loadConsoleConfig(client), loadConsoleModels(client)]);
      let entries: ConsoleConfigWrite[];
      if (initial.profile) {
        entries = modelProfileChangeWrites(latestModels, latestConfig, account.uid, initial.profile, { kind: "edit", ...draft });
      } else {
        const writable = writableModelProfiles(latestModels, latestConfig, account.uid).map((entry) => ({ ...entry, values: { ...entry.values, "config/ai/api_key": "" } }));
        const visible = [...writable, ...modelProfilesFromListing(latestModels, [], account.uid)];
        const next = createModelProfile(writable, draft.name, draft.values, Date.now(), editableModelSource(account.uid), visible);
        const added = next[next.length - 1];
        entries = modelProfileSaveEntries(account.uid, next);
        if (draft.first) entries.push(preferredModelSaveEntry(account.uid, added.id));
      }
      await saveConsoleConfigEntries(client, { entries });
    },
    onSuccess: async () => {
      await Promise.all([cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }), cache.invalidateQueries({ queryKey: SETTINGS_MODELS_KEY })]);
      onDirty(false);
      onSaved();
    },
    onError: async () => {
      await Promise.all([cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }), cache.invalidateQueries({ queryKey: SETTINGS_MODELS_KEY })]);
    },
  });
  const pending = save.isPending || login.isPending;
  const dirty = valuesChanged || name !== (initial.profile?.name ?? "") || makeFirst || clearApiKey || !!login.data;
  useLayoutEffect(() => { onDirty(dirty || pending); }, [dirty, pending, onDirty]);
  useLayoutEffect(() => () => onDirty(false), [onDirty]);
  const change = (key: string, value: string) => { setValues((current) => ({ ...current, [`config/ai/${key}`]: value })); save.reset(); };
  const canSave = editable && !!provider && !!model.trim() && !duplicateName && !pending && dirty
    && (!custom || !!values["config/ai/base_url"]?.trim())
    && (!testRequired || !codex || (authenticated && !!transport && transport !== "gsv"));
  const connectionOrigin = <label>{t("settings.models.connectThrough")}<select name="transport" value={transport} onChange={(event) => change("transport_target", event.currentTarget.value)} required={codex}>
    {codex ? <option value="" disabled>{t("settings.models.chooseMachine")}</option> : <option value="gsv">{t("settings.models.cloudHome")}</option>}
    {transport && transport !== "gsv" && !fetchTargets.some((target) => target.deviceId === transport) && <option value={transport}>{t("settings.unavailableOption", { value: transport })}</option>}
    {fetchTargets.map((target) => <option key={target.deviceId} value={target.deviceId}>{target.online ? target.label || target.deviceId : t("settings.models.offline", { name: target.label || target.deviceId })}</option>)}
  </select></label>;
  const error = save.error ?? login.error ?? (codex ? auth.error : null);

  return <div class="settings-model-editor">
    <div class="settings-model-heading"><h2>{t(initial.profile ? "settings.models.edit" : "settings.models.addTitle")}</h2><button class="settings-text-action" type="button" disabled={pending} onClick={onCancel}>{t("common.cancel")}</button></div>
    <form class="settings-form settings-add-model" aria-label={t(initial.profile ? "settings.models.edit" : "settings.models.addTitle")} onSubmit={(event) => {
      event.preventDefault();
      if (!canSave) return;
      save.mutate({ name: displayName, values: { ...values, "config/ai/model": model, "config/ai/transport_target": fixedModel ? "" : values["config/ai/transport_target"] || (codex ? transport : "") }, first: makeFirst, clearApiKey: clearApiKey || (connectionChanged && !values["config/ai/api_key"]?.trim()) });
    }}>
      <fieldset disabled={!editable || pending}>
        <label>{t("settings.models.provider")}<select name="provider" value={provider} required onChange={(event) => {
          const next = event.currentTarget.value;
          setValues({
            "config/ai/provider": next,
            "config/ai/oauth_account_key": next === "openai-codex" ? crypto.randomUUID() : "",
          });
          setClearApiKey(false);
          setSignedIn(false);
          setSignInError(null);
          login.reset();
          save.reset();
        }}><option value="" disabled>{t("settings.models.chooseProvider")}</option>{provider && !providers.some((option) => option.value === provider) && <option value={provider}>{provider}</option>}{providers.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {provider && <>
          {codex && <div class="settings-model-login">
            <p class="settings-muted">{t("settings.models.codexHint")}</p>
            {authenticated && <p role="status">{auth.data?.email ? t("settings.models.connectedAs", { email: auth.data.email }) : t("settings.models.chatgptConnected")}</p>}
            <button class={authenticated ? "settings-text-action" : "ibtn"} type="button" onClick={() => login.mutate(crypto.randomUUID())} disabled={login.isPending}>{login.isPending ? <LoadingState>{t("settings.models.connecting")}</LoadingState> : t(authenticated ? "settings.models.changeAccount" : login.data ? "settings.models.restartSignIn" : "settings.models.signInChatgpt")}</button>
            {!authenticated && <>
              {login.data && loginUrl && <p>{rich(t("settings.models.enterCode"), { code: <strong class="settings-login-code">{login.data.userCode}</strong>, link: <a href={loginUrl} target="_blank" rel="noreferrer">{t("settings.models.openaiSignIn")}</a> })}</p>}
              {login.data && loginUrl && <p class="settings-muted">{t("settings.models.browserProfile")}</p>}
            </>}
            {signInError && <p class="settings-error" role="alert">{t(signInError)}</p>}
          </div>}
          {!fixedModel && <label>{t("settings.models.model")}<input name="model" value={model} required autoComplete="off" placeholder={t("settings.models.modelPlaceholder")} onInput={(event) => change("model", event.currentTarget.value)} /></label>}
          {fixedModel && <p class="settings-muted">{t("settings.models.includedHint")}</p>}
          {custom && <label>{t("settings.models.endpointUrl")}<input name="base-url" type="url" value={values["config/ai/base_url"] ?? ""} placeholder="https://…/v1" required onInput={(event) => change("base_url", event.currentTarget.value)} /></label>}
          {!codex && !fixedModel && provider !== "workers-ai" && <>
            <label>{t("settings.models.apiKey")}
              {hasStoredKey && !connectionChanged && !clearApiKey && <small>{t("settings.models.keySaved")}</small>}
              {hasStoredKey && connectionChanged && <small>{t("settings.models.keyConnectionChanged")}</small>}
              <input name="api-key" type="password" value={values["config/ai/api_key"] ?? ""} autoComplete="new-password" onInput={(event) => { setClearApiKey(false); change("api_key", event.currentTarget.value); }} />
            </label>
            {hasStoredKey && !connectionChanged && <label class="settings-check"><input name="clear-api-key" type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.currentTarget.checked); change("api_key", ""); }} />{t("settings.models.removeKey")}</label>}
          </>}
          {codex && <>{connectionOrigin}<p class="settings-muted">{t(fetchTargets.length === 0 ? "settings.models.codexNoMachine" : "settings.models.codexChooseMachine")}</p></>}
          <label>{t("settings.models.name")} <small>{t("settings.models.nameHint")}</small><input name="display-name" value={name} maxLength={80} placeholder={model || t("settings.models.namePlaceholder")} aria-invalid={duplicateName} onInput={(event) => { setName(event.currentTarget.value); save.reset(); }} /></label>
          {duplicateName && <p class="settings-error" role="alert">{t("settings.models.duplicateName")}</p>}
          <details class="settings-model-options"><summary>{t("settings.models.moreOptions")}</summary>
            {!fixedModel && !codex && <>
              {connectionOrigin}
              {!custom && <label>{t("settings.models.endpointUrl")} <small>{t("settings.models.optional")}</small><input name="base-url" type="url" value={values["config/ai/base_url"] ?? ""} onInput={(event) => change("base_url", event.currentTarget.value)} /></label>}
              <label>{t("settings.models.apiFormat")}<select name="api-format" value={values["config/ai/provider_style"] || "auto"} onChange={(event) => change("provider_style", event.currentTarget.value)}>
                <option value="auto">{t("settings.models.automatic")}</option><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
              </select></label>
            </>}
            <label>{t("settings.models.maxTokens")}<input name="max-tokens" type="number" min="1" step="1" value={values["config/ai/max_tokens"] ?? ""} placeholder={t("settings.models.providerDefault")} onInput={(event) => change("max_tokens", event.currentTarget.value)} /></label>
            <label>{t("settings.models.contextTokens")}<input name="context-window" type="number" min="1" step="1" value={values["config/ai/context_window_tokens"] ?? ""} placeholder={t("settings.models.automatic")} onInput={(event) => change("context_window_tokens", event.currentTarget.value)} /></label>
          </details>
          {!initial.profile && <label class="settings-check"><input name="make-first" type="checkbox" checked={makeFirst} onChange={(event) => setMakeFirst(event.currentTarget.checked)} />{t("settings.models.useThisFirst")}</label>}
        </>}
      </fieldset>
      {error && <p class="settings-error" role="alert">{error.message}</p>}
      {targets.error && <p class="settings-error" role="alert">{t("settings.models.machinesFailed", { error: targets.error.message })}</p>}
      <div class="settings-actions"><button class="ibtn" type="submit" disabled={!canSave}>{save.isPending ? <LoadingState>{t(testRequired ? "settings.models.testingSaving" : "common.saving")}</LoadingState> : t(initial.profile ? testRequired ? "settings.models.testSave" : "settings.models.saveChanges" : "settings.models.testAdd")}</button></div>
      {testRequired && <p class="settings-muted">{t(initial.profile ? "settings.models.checkBeforeSave" : "settings.models.checkBeforeAdd")}</p>}
    </form>
  </div>;
}
