import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { reasoningOptions } from "../../../components/ui/AgentEditor";
import { LoadingState } from "../../../components/ui/Spinner";
import { aiProviderDisplayLabel } from "../../../domain/aiProviders";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleConfig, loadConsoleModels, saveConsoleConfig, saveConsoleConfigEntries } from "../../gsv-console/backend/consoleService";
import { inheritedReasoningForAccount } from "../../gsv-console/domain/consoleAgentBehavior";
import { editableModelSource } from "../../gsv-console/domain/consoleSettings";
import { configuredModelOrder, modelOrderWrites, moveModel, orderedModels, useModelFirst, type ModelStackDraft } from "./modelStack";
import { canConfigure, SETTINGS_CONFIG_KEY, SETTINGS_MODELS_KEY } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

export function Preferences({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: SETTINGS_CONFIG_KEY, queryFn: () => loadConsoleConfig(client), enabled: connected && active });
  const models = useQuery({ queryKey: SETTINGS_MODELS_KEY, queryFn: () => loadConsoleModels(client), enabled: connected && active });
  const [orderDraft, setOrderDraft] = useState<ModelStackDraft | null>(null);
  const [reasoningDraft, setReasoningDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const editable = connected && !config.isError && !!config.data && canConfigure(account, "sys.config.set");
  const stackEditable = editable && !!models.data && !models.isError;
  const originalOrder = models.data ? configuredModelOrder(models.data, account.uid) : null;
  const order = orderDraft ?? originalOrder;
  const orderDirty = !!orderDraft && JSON.stringify(orderDraft) !== JSON.stringify(originalOrder);
  const rows = models.data && order ? orderedModels(models.data, order, account.uid) : [];
  const ownRows = rows.filter((model) => model.source === editableModelSource(account.uid));
  const reasoningKey = `users/${account.uid}/ai/reasoning`;
  const originalReasoning = config.data?.find((entry) => entry.key === reasoningKey)?.value ?? "";
  const reasoning = reasoningDraft ?? originalReasoning;
  const effortOptions = reasoningOptions(inheritedReasoningForAccount(config.data ?? [], account.uid, account.uid));
  useSettingsDirty(orderDirty || reasoning !== originalReasoning, onDirty);

  const refresh = () => Promise.all([
    cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }),
    cache.invalidateQueries({ queryKey: SETTINGS_MODELS_KEY }),
  ]);
  const saveOrder = useMutation({
    mutationFn: async (draft: ModelStackDraft) => {
      if (!models.data || !config.data || !stackEditable) throw new Error("Your model stack is not available to edit.");
      await saveConsoleConfigEntries(client, { entries: modelOrderWrites(models.data, config.data, account.uid, draft) });
    },
    onSuccess: async () => { await refresh(); setOrderDraft(null); setSaved("models"); },
    onError: async () => { await refresh(); },
  });
  const saveReasoning = useMutation({
    mutationFn: (value: string) => saveConsoleConfig(client, { key: reasoningKey, value }),
    onSuccess: async () => { await refresh(); setReasoningDraft(null); setSaved("reasoning"); },
  });
  const saving = saveOrder.isPending || saveReasoning.isPending;
  const updateOrder = (next: ModelStackDraft) => { setOrderDraft(next); setSaved(null); saveOrder.reset(); };

  return <section aria-labelledby="settings-preferences-title">
    <h1 id="settings-preferences-title">Preferences</h1>
    <p class="settings-intro">Defaults for {account.displayName || account.username}. Agents without their own overrides inherit their owner’s defaults.</p>
    <SettingsError error={config.error ?? models.error ?? saveOrder.error ?? saveReasoning.error} />
    {connected && (config.isPending || models.isPending) && <LoadingState variant="panel">Loading preferences…</LoadingState>}
    {!canConfigure(account, "sys.config.set") && <p class="settings-muted">Your account can view these preferences but cannot change them.</p>}
    <h2>Model order</h2>
    <p class="settings-muted">The first model is tried first. If it cannot complete the reply, the next model takes over.</p>
    <form class="settings-form" aria-label="Model order" onSubmit={(event) => {
      event.preventDefault();
      if (stackEditable && order && orderDirty && !saving) saveOrder.mutate(order);
    }}>
      <ol class="settings-model-stack">{rows.map((model, index) => {
        const own = model.source === editableModelSource(account.uid);
        const ownIndex = ownRows.findIndex((entry) => entry.id === model.id);
        return <li key={model.id} data-model-id={model.id}>
          <span class="settings-model-position">{index === 0 ? "First choice" : `Fallback ${index}`}</span>
          <div class="settings-model-details">
            <strong>{model.name}</strong>
            <span>{aiProviderDisplayLabel(model.provider)} / {model.model}</span>
            <small>{own ? account.uid === 0 ? "Installation model" : "Your model" : model.source === "base" ? "Included model" : "Shared model"}</small>
          </div>
          <div class="settings-actions">
            {index > 0 && <button class="ibtn" type="button" aria-label={`Use ${model.name} first`} disabled={!stackEditable || saving} onClick={() => { if (models.data && order) updateOrder(useModelFirst(models.data, order, account.uid, model.id)); }}>use first</button>}
            {own && ownRows.length > 1 && <>
              <button class="ibtn" type="button" aria-label={`Move ${model.name} up`} disabled={!stackEditable || saving || ownIndex === 0} onClick={() => { if (models.data && order) updateOrder(moveModel(models.data, order, account.uid, model.id, -1)); }}>↑</button>
              <button class="ibtn" type="button" aria-label={`Move ${model.name} down`} disabled={!stackEditable || saving || ownIndex === ownRows.length - 1} onClick={() => { if (models.data && order) updateOrder(moveModel(models.data, order, account.uid, model.id, 1)); }}>↓</button>
            </>}
          </div>
        </li>;
      })}</ol>
      {models.data?.models.length === 0 && <p>No models are available.</p>}
      {rows.some((model) => model.source !== editableModelSource(account.uid)) && <p class="settings-muted">Shared and included models keep their configured fallback order. You can still choose one to go first.</p>}
      <div class="settings-actions">
        <button class="ibtn" disabled={!stackEditable || saving || !orderDirty} type="submit">{saveOrder.isPending ? <LoadingState>saving…</LoadingState> : "save model order"}</button>
        {orderDirty && <button class="ibtn" type="button" disabled={saving} onClick={() => { setOrderDraft(null); saveOrder.reset(); }}>discard changes</button>}
        {order?.preferredId && <button class="ibtn" type="button" disabled={!stackEditable || saving} onClick={() => updateOrder({ ...order, preferredId: null })}>use configured order</button>}
        {saved === "models" && <span role="status">saved</span>}
      </div>
    </form>
    <form class="settings-form" aria-label="Reasoning effort" onSubmit={(event) => { event.preventDefault(); if (editable && !saving) saveReasoning.mutate(reasoning); }}>
      <label>Reasoning effort<select value={reasoning} disabled={!editable || saving} onChange={(event) => { setReasoningDraft(event.currentTarget.value); setSaved(null); saveReasoning.reset(); }}>
        {reasoning && !effortOptions.some((option) => option.value === reasoning) && <option value={reasoning}>{reasoning} (unavailable)</option>}
        {effortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <div class="settings-actions"><button class="ibtn" disabled={!editable || saving || reasoning === originalReasoning} type="submit">{saveReasoning.isPending ? <LoadingState>saving…</LoadingState> : "save effort"}</button>
        {saved === "reasoning" && <span role="status">saved</span>}
      </div>
    </form>
  </section>;
}
