import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { aiProviderOptionsForFeatures, fixedAiProviderModel } from "../../../domain/aiProviders";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
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
  makeModelPrimary,
  modelProfilesFromListing,
  modelProfileSaveEntries,
  modelValidationValuesFromProfileDrafts,
  preferredModelSaveEntry,
  writableModelProfiles,
  type ConsoleModelListing,
} from "../../gsv-console/domain/consoleSettings";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { canConfigure, SETTINGS_CONFIG_KEY, SETTINGS_MODELS_KEY, signInUrl } from "./settingsModel";

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
  const { snapshot } = useSession();
  const cache = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [makeFirst, setMakeFirst] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [signInError, setSignInError] = useState("");
  const provider = values["config/ai/provider"] ?? "";
  const fixedModel = fixedAiProviderModel(provider);
  const codex = provider === "openai-codex";
  const custom = provider === "custom";
  const model = fixedModel ?? values["config/ai/model"] ?? "";
  const displayName = name.trim() || (fixedModel ? "GSV included" : model.trim().slice(0, 80));
  const profiles = modelProfilesFromListing(models, config, account.uid);
  const duplicateName = profiles.some((profile) => profile.name.toLowerCase() === displayName.toLowerCase());
  const providers = aiProviderOptionsForFeatures(snapshot.server?.features);
  const targets = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected && active });
  const fetchTargets = (targets.data ?? []).filter((target) => target.implements.some((capability) => capability === "net.fetch" || capability === "net.*" || capability === "*"));
  const transport = values["config/ai/transport_target"] || (codex ? "" : "gsv");
  const editable = connected && canConfigure(account, "sys.config.set");
  const auth = useQuery({ queryKey: ["instrument", "codex-sign-in"], queryFn: () => checkConsoleOpenAiCodexOAuth(client), enabled: editable && active && codex });
  const login = useMutation({
    mutationFn: () => startConsoleOpenAiCodexOAuth(client),
    onMutate: () => { setSignedIn(false); setSignInError(""); },
  });
  const authenticated = signedIn || (auth.data?.connected === true && !login.data);
  const loginUrl = signInUrl(login.data?.verificationUrl ?? null);

  useEffect(() => {
    const flow = login.data;
    if (!active || !codex || !flow || signedIn || signInError) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= flow.expiresAt) { setSignInError("This sign-in code has expired. Start again."); return; }
      try {
        const result = await pollConsoleOpenAiCodexOAuth(client, { flowId: flow.flow.flowId });
        if (cancelled) return;
        if (result.status === "complete") {
          setSignedIn(true);
          void cache.invalidateQueries({ queryKey: ["instrument", "codex-sign-in"] });
        } else timer = setTimeout(() => void poll(), Math.max(1, result.intervalSeconds) * 1000);
      } catch {
        if (!cancelled) setSignInError("Could not finish sign-in. Start again to get a new code.");
      }
    };
    timer = setTimeout(() => void poll(), Math.max(1, flow.intervalSeconds) * 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, codex, login.data, signedIn, signInError, client, cache]);

  const save = useMutation({
    mutationFn: async (draft: { name: string; values: Record<string, string>; first: boolean }) => {
      await validateConsoleModelConfig(client, { values: modelValidationValuesFromProfileDrafts(draft.values) });
      const writable = writableModelProfiles(models, config, account.uid);
      let next = createModelProfile(writable, draft.name, draft.values, Date.now(), editableModelSource(account.uid), profiles);
      const added = next[next.length - 1];
      if (draft.first) next = makeModelPrimary(next, added.id);
      const entries = modelProfileSaveEntries(account.uid, next);
      if (draft.first) entries.push(preferredModelSaveEntry(account.uid, null));
      await saveConsoleConfigEntries(client, { entries });
    },
    onSuccess: async () => {
      await Promise.all([cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }), cache.invalidateQueries({ queryKey: SETTINGS_MODELS_KEY })]);
      onDirty(false);
      onAdded();
    },
  });
  const pending = save.isPending || login.isPending;
  const dirty = Object.values(values).some(Boolean) || name !== "" || makeFirst || !!login.data;
  useLayoutEffect(() => { onDirty(dirty || pending); }, [dirty, pending, onDirty]);
  useLayoutEffect(() => () => onDirty(false), [onDirty]);
  const change = (key: string, value: string) => { setValues((current) => ({ ...current, [`config/ai/${key}`]: value })); save.reset(); };
  const canSave = editable && !!provider && !!model.trim() && !duplicateName && !pending
    && (!custom || !!values["config/ai/base_url"]?.trim())
    && (!codex || (authenticated && !!transport && transport !== "gsv"));
  const connectionOrigin = <label>Connect through<select name="transport" value={transport} onChange={(event) => change("transport_target", event.currentTarget.value)} required={codex}>
    {codex ? <option value="" disabled>Choose a machine</option> : <option value="gsv">Your cloud home</option>}
    {fetchTargets.map((target) => <option key={target.deviceId} value={target.deviceId}>{target.label || target.deviceId}{target.online ? "" : " (offline)"}</option>)}
  </select></label>;
  const error = save.error ?? login.error ?? (codex ? auth.error : null);

  return <div class="settings-model-editor">
    <div class="settings-model-heading"><h2>Add model</h2><button class="settings-text-action" type="button" disabled={pending} onClick={onCancel}>cancel</button></div>
    <form class="settings-form settings-add-model" aria-label="Add model" onSubmit={(event) => {
      event.preventDefault();
      if (!canSave) return;
      save.mutate({ name: displayName, values: { ...values, "config/ai/model": model, "config/ai/transport_target": fixedModel ? "" : transport }, first: makeFirst });
    }}>
      <fieldset disabled={!editable || pending}>
        <label>Provider<select name="provider" value={provider} required onChange={(event) => {
          const next = event.currentTarget.value;
          setValues({ "config/ai/provider": next });
          setSignedIn(false);
          setSignInError("");
          login.reset();
          save.reset();
        }}><option value="" disabled>Choose a provider</option>{providers.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {provider && <>
          {codex && <div class="settings-model-login">
            <p class="settings-muted">Use your ChatGPT subscription.</p>
            {authenticated ? <p role="status">ChatGPT is connected.</p> : <>
              <button class="ibtn" type="button" onClick={() => login.mutate()} disabled={login.isPending}>{login.isPending ? <LoadingState>connecting…</LoadingState> : login.data ? "start sign-in again" : "sign in with ChatGPT"}</button>
              {login.data && loginUrl && <p>Enter <strong class="settings-login-code">{login.data.userCode}</strong> at <a href={loginUrl} target="_blank" rel="noreferrer">OpenAI sign-in ↗</a>.</p>}
            </>}
            {signInError && <p class="settings-error" role="alert">{signInError}</p>}
          </div>}
          {!fixedModel && <label>Model<input name="model" value={model} required autoComplete="off" placeholder="Model ID from your provider" onInput={(event) => change("model", event.currentTarget.value)} /></label>}
          {fixedModel && <p class="settings-muted">Use the model included with your installation.</p>}
          {custom && <label>Endpoint URL<input name="base-url" type="url" value={values["config/ai/base_url"] ?? ""} placeholder="https://…/v1" required onInput={(event) => change("base_url", event.currentTarget.value)} /></label>}
          {!codex && !fixedModel && provider !== "workers-ai" && <label>API key<input name="api-key" type="password" value={values["config/ai/api_key"] ?? ""} autoComplete="off" onInput={(event) => change("api_key", event.currentTarget.value)} /></label>}
          {codex && <>{connectionOrigin}<p class="settings-muted">Codex requests need a connected machine. {fetchTargets.length === 0 ? "Connect one in Fleet first." : "Choose where your requests should start."}</p></>}
          <label>Name <small>Optional · how it appears in your stack</small><input name="display-name" value={name} maxLength={80} placeholder={model || "Model name"} aria-invalid={duplicateName} onInput={(event) => { setName(event.currentTarget.value); save.reset(); }} /></label>
          {duplicateName && <p class="settings-error" role="alert">That name is already in your stack. Give this model a different name.</p>}
          <details class="settings-model-options"><summary>More options</summary>
            {!fixedModel && !codex && <>
              {connectionOrigin}
              {!custom && <label>Endpoint URL <small>Optional</small><input name="base-url" type="url" value={values["config/ai/base_url"] ?? ""} onInput={(event) => change("base_url", event.currentTarget.value)} /></label>}
              <label>API format<select name="api-format" value={values["config/ai/provider_style"] || "auto"} onChange={(event) => change("provider_style", event.currentTarget.value)}>
                <option value="auto">Automatic</option><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
              </select></label>
            </>}
            <label>Maximum output tokens<input name="max-tokens" type="number" min="1" step="1" value={values["config/ai/max_tokens"] ?? ""} placeholder="Provider default" onInput={(event) => change("max_tokens", event.currentTarget.value)} /></label>
            <label>Context window tokens<input name="context-window" type="number" min="1" step="1" value={values["config/ai/context_window_tokens"] ?? ""} placeholder="Automatic" onInput={(event) => change("context_window_tokens", event.currentTarget.value)} /></label>
          </details>
          <label class="settings-check"><input name="make-first" type="checkbox" checked={makeFirst} onChange={(event) => setMakeFirst(event.currentTarget.checked)} />Use this model first</label>
        </>}
      </fieldset>
      {error && <p class="settings-error" role="alert">{error.message}</p>}
      {targets.error && <p class="settings-error" role="alert">Could not load machines: {targets.error.message}</p>}
      <div class="settings-actions"><button class="ibtn" type="submit" disabled={!canSave}>{save.isPending ? <LoadingState>testing and adding…</LoadingState> : "test and add model"}</button></div>
      <p class="settings-muted">We’ll check the connection before adding it to your stack.</p>
    </form>
  </div>;
}
