import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { ModelEditor } from "./ModelEditor";
import { Timezone } from "./Timezone";
import { useRef, useState } from "preact/hooks";
import { reasoningOptions } from "../../../components/ui/AgentEditor";
import { LoadingState } from "../../../components/ui/Spinner";
import { aiProviderDisplayLabel } from "../../../domain/aiProviders";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleConfig, loadConsoleModels, saveConsoleConfig, saveConsoleConfigEntries } from "../../gsv-console/backend/consoleService";
import { inheritedReasoningForAccount } from "../../gsv-console/domain/consoleAgentBehavior";
import { editableModelSource, modelProfilesFromListing, type ConsoleModelProfile } from "../../gsv-console/domain/consoleSettings";
import { modelProfileChangeWrites } from "./modelProfiles";
import { configuredModelOrder, modelOrderWrites, moveModel, moveModelTo, orderedModels, useModelFirst, type ModelStackDraft } from "./modelStack";
import { canConfigure, SETTINGS_CONFIG_KEY, SETTINGS_MODELS_KEY } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

export function Preferences({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: SETTINGS_CONFIG_KEY, queryFn: () => loadConsoleConfig(client), enabled: connected && active });
  const models = useQuery({ queryKey: SETTINGS_MODELS_KEY, queryFn: () => loadConsoleModels(client), enabled: connected && active });
  const [orderDraft, setOrderDraft] = useState<ModelStackDraft | null>(null);
  const [reasoningDraft, setReasoningDraft] = useState<string | null>(null);
  const [modelEditor, setModelEditor] = useState<{ profile?: ConsoleModelProfile } | null>(null);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [removingModel, setRemovingModel] = useState<string | null>(null);
  const [modelDraftDirty, setModelDraftDirty] = useState(false);
  const [timezoneDirty, setTimezoneDirty] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean; to: number | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const editable = connected && !config.isError && !!config.data && canConfigure(account, "sys.config.set");
  const stackEditable = editable && !!models.data && !models.isError;
  const originalOrder = models.data ? configuredModelOrder(models.data) : null;
  const order = orderDraft ?? originalOrder;
  const orderDirty = !!orderDraft && JSON.stringify(orderDraft) !== JSON.stringify(originalOrder);
  const rows = models.data && order ? orderedModels(models.data, order) : [];
  const reasoningKey = `users/${account.uid}/ai/reasoning`;
  const originalReasoning = config.data?.find((entry) => entry.key === reasoningKey)?.value ?? "";
  const reasoning = reasoningDraft ?? originalReasoning;
  const effortOptions = reasoningOptions(inheritedReasoningForAccount(config.data ?? [], account.uid, account.uid));

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
  const removeModel = useMutation({
    mutationFn: async (profile: ConsoleModelProfile) => {
      const [latestConfig, latestModels] = await Promise.all([loadConsoleConfig(client), loadConsoleModels(client)]);
      await saveConsoleConfigEntries(client, { entries: modelProfileChangeWrites(latestModels, latestConfig, account.uid, profile, { kind: "remove" }) });
    },
    onSuccess: async () => { await refresh(); setRemovingModel(null); setExpandedModel(null); setSaved("model-removed"); },
    onError: async () => { await refresh(); },
  });
  const saving = saveOrder.isPending || saveReasoning.isPending || removeModel.isPending;
  useSettingsDirty(orderDirty || reasoning !== originalReasoning || modelDraftDirty || timezoneDirty || saving, onDirty);
  const updateOrder = (next: ModelStackDraft) => { setOrderDraft(next); setSaved(null); saveOrder.reset(); };

  return <section aria-labelledby="settings-preferences-title">
    <h1 id="settings-preferences-title">Preferences</h1>
    <p class="settings-intro">Defaults for {account.displayName || account.username}. Agents without their own overrides inherit their owner’s defaults.</p>
    <SettingsError error={config.error ?? models.error ?? saveOrder.error ?? saveReasoning.error ?? removeModel.error} />
    {connected && (config.isPending || models.isPending) && <LoadingState variant="panel">Loading preferences…</LoadingState>}
    {!canConfigure(account, "sys.config.set") && <p class="settings-muted">Your account can view these preferences but cannot change them.</p>}
    {modelEditor && models.data && config.data ? <ModelEditor key={modelEditor.profile?.id ?? "new"} account={account} config={config.data} models={models.data} profile={modelEditor.profile} active={active} onDirty={setModelDraftDirty} onCancel={() => {
      if (!modelDraftDirty || window.confirm("Discard these unsaved model changes?")) { setModelDraftDirty(false); setModelEditor(null); }
    }} onSaved={() => { setModelDraftDirty(false); setModelEditor(null); setSaved(modelEditor.profile ? "model-updated" : "model-added"); }} /> : <>
    <div class="settings-model-heading"><h2>Model order</h2><button class="settings-text-action" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => { setSaved(null); setModelEditor({}); }}>add model</button></div>
    {orderDirty && <p class="settings-muted">Save or discard your order changes before adding, editing or removing a model.</p>}
    {saved === "model-added" && <p role="status">Model added to your stack.</p>}
    {saved === "model-updated" && <p role="status">Model updated.</p>}
    {saved === "model-removed" && <p role="status">Model removed from your stack.</p>}
    <p class="settings-muted">The first model is tried first. If it cannot complete the reply, the next model takes over.</p>
    <form class="settings-form" aria-label="Model order" onSubmit={(event) => {
      event.preventDefault();
      if (stackEditable && order && orderDirty && !saving) saveOrder.mutate(order);
    }}>
      <ol class="settings-model-stack" aria-label="Model fallback order">{rows.map((model, index) => {
        const own = model.source === editableModelSource(account.uid);
        const profile = models.data && modelProfilesFromListing(models.data, [], account.uid).find((entry) => entry.id === model.id);
        const expanded = expandedModel === model.id;
        const draggable = rows.length > 1 && stackEditable && !saving;
        return <li key={model.id} data-model-id={model.id} class={`${draggable ? "is-draggable" : ""}${dragging === model.id ? " is-dragging" : ""}${dropTarget === model.id ? " is-drop-target" : ""}`} onPointerDown={(event) => {
          if (!draggable || event.button !== 0 || (event.target as Element).closest("button, a, input, .settings-model-inspector")) return;
          drag.current = { id: model.id, x: event.clientX, y: event.clientY, moved: false, to: null };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== model.id) return;
          if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
          current.moved = true;
          setDragging(current.id);
          const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".settings-model-stack > li");
          const to = rows.findIndex((entry) => entry.id === row?.dataset.modelId);
          current.to = to >= 0 ? to : null;
          setDropTarget(to >= 0 ? rows[to].id : null);
        }} onPointerUp={(event) => {
          const current = drag.current;
          if (!current || current.id !== model.id) return;
          if (current.moved && current.to !== null && models.data && order && stackEditable && !saving) {
            updateOrder(moveModelTo(models.data, order, current.id, current.to));
          }
          drag.current = null;
          setDragging(null);
          setDropTarget(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }} onLostPointerCapture={() => { drag.current = null; setDragging(null); setDropTarget(null); }}>
          <span class="settings-model-position">{draggable && <span class="settings-model-grip" aria-hidden="true">⠿</span>}{index === 0 ? "First choice" : `Fallback ${index}`}</span>
          <div class="settings-model-details">
            <strong>{model.name}</strong>
            <span>{aiProviderDisplayLabel(model.provider)} / {model.model}</span>
            <small>{own ? account.uid === 0 ? "Installation model" : "Your model" : model.source === "base" ? "Included model" : "Shared model"}</small>
            <button class="settings-text-action settings-model-disclosure" type="button" aria-expanded={expanded} aria-controls={`model-details-${model.id}`} aria-label={`Details for ${model.name}`} disabled={saving} onClick={() => { setExpandedModel(expanded ? null : model.id); setRemovingModel(null); removeModel.reset(); }}>{expanded ? "close details" : "details"}</button>
          </div>
          <div class="settings-actions">
            {index > 0 && <button class="settings-text-action" type="button" aria-label={`Use ${model.name} first`} disabled={!stackEditable || saving} onClick={() => { if (models.data && order) updateOrder(useModelFirst(models.data, order, model.id)); }}>use first</button>}
            {rows.length > 1 && <>
              <button class="settings-text-action settings-model-move" type="button" aria-label={`Move ${model.name} up`} disabled={!stackEditable || saving || index === 0} onClick={() => { if (models.data && order) updateOrder(moveModel(models.data, order, model.id, -1)); }}>↑</button>
              <button class="settings-text-action settings-model-move" type="button" aria-label={`Move ${model.name} down`} disabled={!stackEditable || saving || index === rows.length - 1} onClick={() => { if (models.data && order) updateOrder(moveModel(models.data, order, model.id, 1)); }}>↓</button>
            </>}
          </div>
          {expanded && <div class="settings-model-inspector" id={`model-details-${model.id}`}>
            <dl>
              <div><dt>Connect through</dt><dd>{!model.transportTarget || model.transportTarget === "gsv" ? "Your cloud home" : model.transportTarget}</dd></div>
              {model.baseUrl && <div><dt>Endpoint</dt><dd>{model.baseUrl}</dd></div>}
              {model.maxTokens && <div><dt>Maximum output</dt><dd>{model.maxTokens.toLocaleString()} tokens</dd></div>}
              {model.contextWindowTokens && <div><dt>Context window</dt><dd>{model.contextWindowTokens.toLocaleString()} tokens</dd></div>}
            </dl>
            {own && profile ? removingModel === model.id ? <div role="group" aria-label={`Remove ${model.name}`}>
              <p>Remove {model.name} from your stack? Its saved API key will also be removed.</p>
              <div class="settings-actions">
                <button class="settings-text-action settings-danger" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => removeModel.mutate(profile)}>{removeModel.isPending ? <LoadingState>removing…</LoadingState> : "remove model"}</button>
                <button class="settings-text-action" type="button" disabled={saving} onClick={() => { setRemovingModel(null); removeModel.reset(); }}>cancel</button>
              </div>
            </div> : <div class="settings-actions">
              <button class="settings-text-action" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => { setSaved(null); setModelEditor({ profile }); }}>edit</button>
              <button class="settings-text-action settings-danger" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => setRemovingModel(model.id)}>remove</button>
            </div> : <p class="settings-muted">{model.source === "base" ? "Included with your installation." : "Shared by your installation."} You can change its place in your stack; its definition is managed by the installation.</p>}
          </div>}
        </li>;
      })}</ol>
      {models.data?.models.length === 0 && <p>No models are available.</p>}
      {rows.length > 1 && <p class="settings-muted">Drag a model or use the arrows to change your fallback order.</p>}
      <div class="settings-actions">
        <button class="ibtn" disabled={!stackEditable || saving || !orderDirty} type="submit">{saveOrder.isPending ? <LoadingState>saving…</LoadingState> : "save model order"}</button>
        {orderDirty && <button class="settings-text-action" type="button" disabled={saving} onClick={() => { setOrderDraft(null); saveOrder.reset(); }}>discard changes</button>}
        {order?.customized && <button class="settings-text-action" type="button" disabled={!stackEditable || saving} onClick={() => { if (models.data) updateOrder({ ids: models.data.models.map((model) => model.id), customized: false }); }}>use configured order</button>}
        {saved === "models" && <span role="status">saved</span>}
      </div>
    </form>
    </>}
    {!modelEditor && <form class="settings-form" aria-label="Reasoning effort" onSubmit={(event) => { event.preventDefault(); if (editable && !saving) saveReasoning.mutate(reasoning); }}>
      <label>Reasoning effort<select value={reasoning} disabled={!editable || saving} onChange={(event) => { setReasoningDraft(event.currentTarget.value); setSaved(null); saveReasoning.reset(); }}>
        {reasoning && !effortOptions.some((option) => option.value === reasoning) && <option value={reasoning}>{reasoning} (unavailable)</option>}
        {effortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <div class="settings-actions"><button class="ibtn" disabled={!editable || saving || reasoning === originalReasoning} type="submit">{saveReasoning.isPending ? <LoadingState>saving…</LoadingState> : "save effort"}</button>
        {saved === "reasoning" && <span role="status">saved</span>}
      </div>
    </form>}
    {!modelEditor && config.data && <Timezone uid={account.uid} original={config.data.find((entry) => entry.key === `users/${account.uid}/locale/timezone`)?.value ?? ""} fallback={config.data.find((entry) => entry.key === "config/server/timezone")?.value ?? "UTC"} editable={editable} onDirty={setTimezoneDirty} />}
  </section>;
}
