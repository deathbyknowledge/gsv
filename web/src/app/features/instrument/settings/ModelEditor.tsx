import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
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
  const locked = !editable || pending;
  const canSave = editable && !!provider && !!model.trim() && !duplicateName && !pending && dirty
    && (!custom || !!values["config/ai/base_url"]?.trim())
    && (!codex || !!transport)
    && (!testRequired || !codex || (authenticated && !!transport && transport !== "gsv"));
  const connectionOrigin = <Select
    block
    label={t("settings.models.connectThrough")}
    placeholder={codex ? t("settings.models.chooseMachine") : ""}
    disabled={locked}
    selected={transport}
    onSelect={(value) => change("transport_target", value)}
    options={[
      ...(codex ? [] : [{ label: t("settings.models.cloudHome"), value: "gsv" }]),
      ...(transport && transport !== "gsv" && !fetchTargets.some((target) => target.deviceId === transport) ? [{ label: t("settings.unavailableOption", { value: transport }), value: transport }] : []),
      ...fetchTargets.map((target) => ({ label: target.online ? target.label || target.deviceId : t("settings.models.offline", { name: target.label || target.deviceId }), value: target.deviceId })),
    ]}
  />;
  const error = save.error ?? login.error ?? (codex ? auth.error : null);

  return <div class="settings-model-editor">
    <div class="settings-model-heading"><h2>{t(initial.profile ? "settings.models.edit" : "settings.models.addTitle")}</h2><button class="settings-text-action" type="button" disabled={pending} onClick={onCancel}>{t("common.cancel")}</button></div>
    <form class="settings-form settings-add-model" aria-label={t(initial.profile ? "settings.models.edit" : "settings.models.addTitle")} onSubmit={(event) => {
      event.preventDefault();
      if (!canSave) return;
      save.mutate({ name: displayName, values: { ...values, "config/ai/model": model, "config/ai/transport_target": fixedModel ? "" : values["config/ai/transport_target"] || (codex ? transport : "") }, first: makeFirst, clearApiKey: clearApiKey || (connectionChanged && !values["config/ai/api_key"]?.trim()) });
    }}>
      <fieldset disabled={!editable || pending}>
        <Select
          block
          label={t("settings.models.provider")}
          placeholder={t("settings.models.chooseProvider")}
          disabled={locked}
          selected={provider}
          options={[
            ...(provider && !providers.some((option) => option.value === provider) ? [{ label: provider, value: provider }] : []),
            ...providers.map((option) => ({ label: option.label, value: option.value })),
          ]}
          onSelect={(next) => {
            // Re-picking the current provider is not a change; a native select never reported it.
            if (next === provider) return;
            setValues({
              "config/ai/provider": next,
              "config/ai/oauth_account_key": next === "openai-codex" ? crypto.randomUUID() : "",
            });
            setClearApiKey(false);
            setSignedIn(false);
            setSignInError(null);
            login.reset();
            save.reset();
          }}
        />
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
          {!fixedModel && <TextInput label={t("settings.models.model")} value={model} placeholder={t("settings.models.modelPlaceholder")} disabled={locked} inputProps={{ name: "model", required: true, autoComplete: "off" }} onChange={(value) => change("model", value)} />}
          {fixedModel && <p class="settings-muted">{t("settings.models.includedHint")}</p>}
          {custom && <TextInput label={t("settings.models.endpointUrl")} type="url" value={values["config/ai/base_url"] ?? ""} placeholder="https://…/v1" disabled={locked} inputProps={{ name: "base-url", required: true }} onChange={(value) => change("base_url", value)} />}
          {!codex && !fixedModel && provider !== "workers-ai" && <>
            <TextInput
              label={t("settings.models.apiKey")}
              description={hasStoredKey && !connectionChanged && !clearApiKey ? t("settings.models.keySaved") : hasStoredKey && connectionChanged ? t("settings.models.keyConnectionChanged") : ""}
              type="password"
              value={values["config/ai/api_key"] ?? ""}
              placeholder=""
              disabled={locked}
              inputProps={{ name: "api-key", autoComplete: "new-password" }}
              onChange={(value) => { setClearApiKey(false); change("api_key", value); }}
            />
            {hasStoredKey && !connectionChanged && <label class="settings-check"><input name="clear-api-key" type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.currentTarget.checked); change("api_key", ""); }} />{t("settings.models.removeKey")}</label>}
          </>}
          {codex && <>{connectionOrigin}<p class="settings-muted">{t(fetchTargets.length === 0 ? "settings.models.codexNoMachine" : "settings.models.codexChooseMachine")}</p></>}
          <TextInput
            label={t("settings.models.name")}
            description={t("settings.models.nameHint")}
            value={name}
            placeholder={model || t("settings.models.namePlaceholder")}
            status={duplicateName ? "error" : "none"}
            message={duplicateName ? t("settings.models.duplicateName") : ""}
            disabled={locked}
            inputProps={{ name: "display-name", maxLength: 80 }}
            onChange={(value) => { setName(value); save.reset(); }}
          />
          <details class="settings-model-options"><summary>{t("settings.models.moreOptions")}</summary>
            {!fixedModel && !codex && <>
              {connectionOrigin}
              {!custom && <TextInput label={t("settings.models.endpointUrl")} description={t("settings.models.optional")} type="url" value={values["config/ai/base_url"] ?? ""} placeholder="" disabled={locked} inputProps={{ name: "base-url" }} onChange={(value) => change("base_url", value)} />}
              <Select
                block
                label={t("settings.models.apiFormat")}
                disabled={locked}
                selected={values["config/ai/provider_style"] || "auto"}
                onSelect={(value) => change("provider_style", value)}
                options={[
                  { label: t("settings.models.automatic"), value: "auto" },
                  { label: "OpenAI Chat Completions", value: "openai-chat-completions" },
                  { label: "OpenAI Responses", value: "openai-responses" },
                  { label: "Anthropic Messages", value: "anthropic-messages" },
                ]}
              />
            </>}
            <TextInput label={t("settings.models.maxTokens")} type="number" value={values["config/ai/max_tokens"] ?? ""} placeholder={t("settings.models.providerDefault")} disabled={locked} inputProps={{ name: "max-tokens", min: 1, step: 1 }} onChange={(value) => change("max_tokens", value)} />
            <TextInput label={t("settings.models.contextTokens")} type="number" value={values["config/ai/context_window_tokens"] ?? ""} placeholder={t("settings.models.automatic")} disabled={locked} inputProps={{ name: "context-window", min: 1, step: 1 }} onChange={(value) => change("context_window_tokens", value)} />
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
