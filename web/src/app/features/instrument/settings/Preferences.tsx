import { ProductEmailPreferences } from "./ProductEmailPreferences";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { ModelEditor } from "./ModelEditor";
import { ThemePreference } from "./ThemePreference";
import { Timezone } from "./Timezone";
import { Language } from "./Language";
import { useRef, useState } from "preact/hooks";
import { reasoningOptions } from "../../../domain/reasoning";
import { LoadingState } from "../../../components/ui/Spinner";
import { aiProviderDisplayLabel } from "../../../domain/aiProviders";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleConfig, loadConsoleModels, saveConsoleConfig, saveConsoleConfigEntries } from "../../../services/system/consoleService";
import { inheritedReasoningForAccount } from "../../../domain/system/consoleAgentBehavior";
import { editableModelSource, modelProfilesFromListing, type ConsoleModelProfile } from "../../../domain/system/consoleSettings";
import { modelProfileChangeWrites } from "./modelProfiles";
import { configuredModelOrder, modelOrderWrites, moveModel, moveModelTo, orderedModels, useModelFirst, type ModelStackDraft } from "./modelStack";
import { canConfigure, SETTINGS_CONFIG_KEY, SETTINGS_MODELS_KEY } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";
import { useT } from "../../../i18n/locale";

export function Preferences({ account, active, onDirty }: SettingsSectionProps) {
  const t = useT();
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
  const [languageDirty, setLanguageDirty] = useState(false);
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
      if (!models.data || !config.data || !stackEditable) throw new Error(t("settings.models.unavailable"));
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
  useSettingsDirty(orderDirty || reasoning !== originalReasoning || modelDraftDirty || timezoneDirty || languageDirty || saving, onDirty);
  const updateOrder = (next: ModelStackDraft) => { setOrderDraft(next); setSaved(null); saveOrder.reset(); };

  return <section aria-labelledby="settings-preferences-title">
    <h1 id="settings-preferences-title">{t("settings.preferences.title")}</h1>
    <p class="settings-intro">{t("settings.preferences.intro", { name: account.displayName || account.username })}</p>
    <SettingsError error={config.error ?? models.error ?? saveOrder.error ?? saveReasoning.error ?? removeModel.error} />
    {connected && (config.isPending || models.isPending) && <LoadingState variant="panel">{t("settings.preferences.loading")}</LoadingState>}
    {!canConfigure(account, "sys.config.set") && <p class="settings-muted">{t("settings.preferences.readOnly")}</p>}
    {modelEditor && models.data && config.data ? <ModelEditor key={modelEditor.profile?.id ?? "new"} account={account} config={config.data} models={models.data} profile={modelEditor.profile} active={active} onDirty={setModelDraftDirty} onCancel={() => {
      if (!modelDraftDirty || window.confirm(t("settings.models.confirmDiscard"))) { setModelDraftDirty(false); setModelEditor(null); }
    }} onSaved={() => { setModelDraftDirty(false); setModelEditor(null); setSaved(modelEditor.profile ? "model-updated" : "model-added"); }} /> : <>
    <div class="settings-model-heading"><h2>{t("settings.models.title")}</h2><button class="settings-text-action" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => { setSaved(null); setModelEditor({}); }}>{t("settings.models.add")}</button></div>
    {orderDirty && <p class="settings-muted">{t("settings.models.orderPending")}</p>}
    {saved === "model-added" && <p role="status">{t("settings.models.added")}</p>}
    {saved === "model-updated" && <p role="status">{t("settings.models.updated")}</p>}
    {saved === "model-removed" && <p role="status">{t("settings.models.removed")}</p>}
    <p class="settings-muted">{t("settings.models.fallbackHint")}</p>
    <form class="settings-form" aria-label={t("settings.models.title")} onSubmit={(event) => {
      event.preventDefault();
      if (stackEditable && order && orderDirty && !saving) saveOrder.mutate(order);
    }}>
      <ol class="settings-model-stack" aria-label={t("settings.models.fallbackOrder")}>{rows.map((model, index) => {
        const own = model.source === editableModelSource(account.uid);
        const profile = models.data && modelProfilesFromListing(models.data, [], account.uid).find((entry) => entry.id === model.id);
        const expanded = expandedModel === model.id;
        const draggable = rows.length > 1 && stackEditable && !saving;
        return <li key={model.id} data-model-id={model.id} class={`${draggable ? "is-draggable" : ""}${dragging === model.id ? " is-dragging" : ""}${dropTarget === model.id ? " is-drop-target" : ""}`} onPointerDown={(event) => {
          if (!draggable || event.button !== 0 || (event.target instanceof Element && event.target.closest("button, a, input, .settings-model-inspector"))) return;
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
          <span class="settings-model-position">{draggable && <span class="settings-model-grip" aria-hidden="true">⠿</span>}{index === 0 ? t("settings.models.firstChoice") : t("settings.models.fallback", { index })}</span>
          <div class="settings-model-details">
            <strong>{model.name}</strong>
            <span>{aiProviderDisplayLabel(model.provider)} / {model.model}</span>
            <small>{t(own ? account.uid === 0 ? "settings.models.source.installation" : "settings.models.source.own" : model.source === "base" ? "settings.models.source.included" : "settings.models.source.shared")}</small>
            <button class="settings-text-action settings-model-disclosure" type="button" aria-expanded={expanded} aria-controls={`model-details-${model.id}`} aria-label={t("settings.models.detailsFor", { name: model.name })} disabled={saving} onClick={() => { setExpandedModel(expanded ? null : model.id); setRemovingModel(null); removeModel.reset(); }}>{t(expanded ? "settings.models.closeDetails" : "settings.models.details")}</button>
          </div>
          <div class="settings-actions">
            {index > 0 && <button class="settings-text-action" type="button" aria-label={t("settings.models.useFirstLabel", { name: model.name })} disabled={!stackEditable || saving} onClick={() => { if (models.data && order) updateOrder(useModelFirst(models.data, order, model.id)); }}>{t("settings.models.useFirst")}</button>}
            {rows.length > 1 && <>
              <button class="settings-text-action settings-model-move" type="button" aria-label={t("settings.models.moveUp", { name: model.name })} disabled={!stackEditable || saving || index === 0} onClick={() => { if (models.data && order) updateOrder(moveModel(models.data, order, model.id, -1)); }}>↑</button>
              <button class="settings-text-action settings-model-move" type="button" aria-label={t("settings.models.moveDown", { name: model.name })} disabled={!stackEditable || saving || index === rows.length - 1} onClick={() => { if (models.data && order) updateOrder(moveModel(models.data, order, model.id, 1)); }}>↓</button>
            </>}
          </div>
          {expanded && <div class="settings-model-inspector" id={`model-details-${model.id}`}>
            <dl>
              <div><dt>{t("settings.models.connectThrough")}</dt><dd>{!model.transportTarget || model.transportTarget === "gsv" ? t("settings.models.cloudHome") : model.transportTarget}</dd></div>
              {model.baseUrl && <div><dt>{t("settings.models.endpoint")}</dt><dd>{model.baseUrl}</dd></div>}
              {model.maxTokens && <div><dt>{t("settings.models.maxOutput")}</dt><dd>{t("settings.models.tokens", { tokens: model.maxTokens.toLocaleString() })}</dd></div>}
              {model.contextWindowTokens && <div><dt>{t("settings.models.contextWindow")}</dt><dd>{t("settings.models.tokens", { tokens: model.contextWindowTokens.toLocaleString() })}</dd></div>}
            </dl>
            {own && profile ? removingModel === model.id ? <div role="group" aria-label={t("settings.models.removeLabel", { name: model.name })}>
              <p>{t("settings.models.confirmRemove", { name: model.name })}</p>
              <div class="settings-actions">
                <button class="settings-text-action settings-danger" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => removeModel.mutate(profile)}>{removeModel.isPending ? <LoadingState>{t("settings.models.removing")}</LoadingState> : t("settings.models.removeModel")}</button>
                <button class="settings-text-action" type="button" disabled={saving} onClick={() => { setRemovingModel(null); removeModel.reset(); }}>{t("common.cancel")}</button>
              </div>
            </div> : <div class="settings-actions">
              <button class="settings-text-action" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => { setSaved(null); setModelEditor({ profile }); }}>{t("common.edit")}</button>
              <button class="settings-text-action settings-danger" type="button" disabled={!stackEditable || saving || orderDirty} onClick={() => setRemovingModel(model.id)}>{t("common.remove")}</button>
            </div> : <p class="settings-muted">{t(model.source === "base" ? "settings.models.includedNote" : "settings.models.sharedNote")}</p>}
          </div>}
        </li>;
      })}</ol>
      {models.data?.models.length === 0 && <p>{t("settings.models.none")}</p>}
      {rows.length > 1 && <p class="settings-muted">{t("settings.models.dragHint")}</p>}
      <div class="settings-actions">
        <button class="ibtn" disabled={!stackEditable || saving || !orderDirty} type="submit">{saveOrder.isPending ? <LoadingState>{t("common.saving")}</LoadingState> : t("settings.models.saveOrder")}</button>
        {orderDirty && <button class="settings-text-action" type="button" disabled={saving} onClick={() => { setOrderDraft(null); saveOrder.reset(); }}>{t("common.discardChanges")}</button>}
        {order?.customized && <button class="settings-text-action" type="button" disabled={!stackEditable || saving} onClick={() => { if (models.data) updateOrder({ ids: models.data.models.map((model) => model.id), customized: false }); }}>{t("settings.models.useConfigured")}</button>}
        {saved === "models" && <span role="status">{t("common.saved")}</span>}
      </div>
    </form>
    </>}
    {!modelEditor && <form class="settings-form" aria-label={t("settings.reasoning.label")} onSubmit={(event) => { event.preventDefault(); if (editable && !saving) saveReasoning.mutate(reasoning); }}>
      <label>{t("settings.reasoning.label")}<select value={reasoning} disabled={!editable || saving} onChange={(event) => { setReasoningDraft(event.currentTarget.value); setSaved(null); saveReasoning.reset(); }}>
        {reasoning && !effortOptions.some((option) => option.value === reasoning) && <option value={reasoning}>{t("settings.unavailableOption", { value: reasoning })}</option>}
        {effortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <div class="settings-actions"><button class="ibtn" disabled={!editable || saving || reasoning === originalReasoning} type="submit">{saveReasoning.isPending ? <LoadingState>{t("common.saving")}</LoadingState> : t("settings.reasoning.save")}</button>
        {saved === "reasoning" && <span role="status">{t("common.saved")}</span>}
      </div>
    </form>}
    {!modelEditor && config.data && <Language uid={account.uid} original={config.data.find((entry) => entry.key === `users/${account.uid}/locale/language`)?.value ?? ""} editable={editable} onDirty={setLanguageDirty} />}
    {!modelEditor && config.data && <Timezone uid={account.uid} original={config.data.find((entry) => entry.key === `users/${account.uid}/locale/timezone`)?.value ?? ""} fallback={config.data.find((entry) => entry.key === "config/server/timezone")?.value ?? "UTC"} editable={editable} onDirty={setTimezoneDirty} />}
    {!modelEditor && <ThemePreference />}
    {!modelEditor && <ProductEmailPreferences />}
  </section>;
}
