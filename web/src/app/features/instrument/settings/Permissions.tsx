import { saveApprovalPolicy } from "./permissionService";
import { isToolApprovalTargetSelector } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleConfig, loadConsoleTargets } from "../../../services/system/consoleService";
import { APPROVAL_ACTIONS, actionLabel, humanToolCapabilityLabel, targetOptionValue, targetFromOptionValue } from "../../../components/ui/agentToolApprovalOptions";
import { LoadingState } from "../../../components/ui/Spinner";
import { Select } from "../../../components/ui/Select";
import { defaultApprovalPolicyForConfig } from "../../../domain/system/consoleAgentBehavior";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { canConfigure, readSettingsPolicy, settingsAction, settingsPolicySchema, SETTINGS_CONFIG_KEY, type SettingsPolicy } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";
import { permissionOptionsForRule } from "./permissionModel";
import { useT } from "../../../i18n/locale";

export function Permissions({ account, active, onDirty }: SettingsSectionProps) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: SETTINGS_CONFIG_KEY, queryFn: () => loadConsoleConfig(client), enabled: connected && active });
  const targetQuery = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected && active });
  const targets = (targetQuery.data ?? []).map((target) => ({ id: target.deviceId, label: target.label }));
  const key = `users/${account.uid}/ai/tools/approval`;
  const original = config.data?.find((entry) => entry.key === key)?.value ?? "";
  const inherited = defaultApprovalPolicyForConfig(config.data ?? []);
  const [draft, setDraft] = useState<{ inherited: boolean; policy: SettingsPolicy; base: string } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const usesDefault = draft?.inherited ?? !original;
  const policy = usesDefault ? readSettingsPolicy(inherited) : draft?.policy ?? readSettingsPolicy(original);
  const nextValue = usesDefault ? "" : policy ? JSON.stringify(policy) : original;
  const dirty = draft !== null && (usesDefault ? original !== "" : JSON.stringify(readSettingsPolicy(original)) !== nextValue);
  useSettingsDirty(dirty, onDirty);
  const editable = connected && !!config.data && !config.isError && canConfigure(account, "sys.config.set") && policy !== null;
  const save = useMutation({
    mutationFn: (value: string) => saveApprovalPolicy(client, account.uid, draft?.base ?? original, value),
    onError: () => cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }); setDraft(null); setSaved(true); },
  });
  const actionOptions = APPROVAL_ACTIONS.map((action) => ({ label: actionLabel(action), value: action }));
  const update = (next: SettingsPolicy) => { setDraft({ inherited: false, policy: next, base: draft?.base ?? original }); setSaved(false); setError(null); };
  return <section aria-labelledby="settings-permissions-title">
    <h1 id="settings-permissions-title">{t("settings.permissions.title")}</h1>
    <p class="settings-intro">{t("settings.permissions.intro")}</p>
    <p class="settings-muted">{t("settings.permissions.mailHint")}</p>
    <SettingsError error={config.error ?? error ?? save.error} />
    {config.isPending && connected && <LoadingState variant="panel">{t("settings.permissions.loading")}</LoadingState>}
    {targetQuery.error && <p class="settings-muted" role="status">{t("settings.permissions.targetsUnavailable")}</p>}
    {config.data && !policy && <div class="settings-policy-recovery">
      <p class="settings-error" role="alert">{t("settings.permissions.unsupported")}</p>
      <details><summary>{t("settings.permissions.inspect")}</summary><pre>{original}</pre></details>
      <p class="settings-muted">{t("settings.permissions.replaceHint")}</p>
      <button class="settings-text-action" type="button" disabled={!connected || config.isError || !canConfigure(account, "sys.config.set")} onClick={() => {
        const replacement = readSettingsPolicy(inherited);
        if (replacement) update(replacement);
      }}>{t("settings.permissions.prepareReplacement")}</button>
    </div>}
    {!canConfigure(account, "sys.config.set") && <p class="settings-muted">{t("settings.permissions.readOnly")}</p>}
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!editable || !policy) return;
      const parsed = settingsPolicySchema.safeParse(policy);
      if (!usesDefault && !parsed.success) { setError(new Error(t("settings.permissions.invalidRules"))); return; }
      save.mutate(nextValue);
    }}>
      <fieldset disabled={!editable || save.isPending}>
        <label class="settings-check"><input type="checkbox" checked={usesDefault} onChange={(event) => {
          if (policy) { setDraft({ inherited: event.currentTarget.checked, policy, base: draft?.base ?? original }); setSaved(false); }
        }} />{t("settings.permissions.useInherited")}</label>
        {policy && <>
          <Select block label={t("settings.permissions.default")} options={actionOptions} selected={policy.default} disabled={usesDefault} onSelect={(value) => update({ ...policy, default: settingsAction(value) })} />
          <ol class="settings-rules">{policy.rules.map((rule, index) => {
            const options = permissionOptionsForRule(rule, targets);
            return <li key={index}>
            <div class="settings-rule-field is-tool">
              <Select block label={t("settings.permissions.tool")} ariaLabel={t("settings.permissions.ruleTool", { number: index + 1 })} options={options.tools} selected={rule.match} placeholder={t("settings.permissions.chooseTool")} disabled={usesDefault} onSelect={(value) => update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? { ...entry, match: value } : entry) })} />
              {options.customToolLabel && <p class="settings-field-note">{options.customToolLabel}</p>}
            </div>
            <div class="settings-rule-field">
              <Select block label={t("settings.permissions.target")} ariaLabel={t("settings.permissions.ruleTarget", { number: index + 1 })} options={options.targets} selected={targetOptionValue(rule.target)} disabled={usesDefault} onSelect={(value) => {
                const target = targetFromOptionValue(value);
                const next: SettingsPolicy["rules"][number] = { match: rule.match, action: rule.action };
                if (target) next.target = target;
                update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? next : entry) });
              }} />
              {rule.target && !isToolApprovalTargetSelector(rule.target) && <p class="settings-field-note">{rule.target}</p>}
            </div>
            <div class="settings-rule-field is-action">
              <Select block label={t("settings.permissions.action")} ariaLabel={t("settings.permissions.ruleAction", { number: index + 1 })} options={actionOptions} selected={rule.action} disabled={usesDefault} onSelect={(value) => update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? { ...entry, action: settingsAction(value) } : entry) })} />
            </div>
            <div class="settings-actions">
              <button class="settings-text-action" type="button" disabled={usesDefault || index === 0} onClick={() => { const rules = [...policy.rules]; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; update({ ...policy, rules }); }}>{t("settings.permissions.moveUp")}</button>
              <button class="settings-text-action" type="button" disabled={usesDefault} onClick={() => update({ ...policy, rules: policy.rules.filter((_, at) => at !== index) })}>{t("common.remove")}</button>
            </div>
          </li>;
          })}</ol>
          <div class="settings-actions">
            <button class="settings-text-action" type="button" disabled={usesDefault} onClick={() => update({ ...policy, rules: [...policy.rules, { match: "", action: "ask" }] })}>{t("settings.permissions.addRule")}</button>
            <button class="ibtn" type="submit" disabled={!dirty}>{save.isPending ? <LoadingState>{t("common.saving")}</LoadingState> : t("settings.permissions.save")}</button>
            {dirty && <button class="settings-text-action" type="button" onClick={() => { setDraft(null); setError(null); save.reset(); }}>{t("common.discardChanges")}</button>}
            {saved && <span role="status">{t("common.saved")}</span>}
          </div>
        </>}
      </fieldset>
    </form>
    <details class="settings-account-grants"><summary>{t("settings.permissions.access")}</summary>
      <p class="settings-muted">{t("settings.permissions.accessHint")}</p>
      {account.capabilities.length ? <ul>{account.capabilities.map((capability) => <li key={capability}><span>{capability === "*" ? t("settings.permissions.allCapabilities") : humanToolCapabilityLabel(capability)}</span><code>{capability}</code></li>)}</ul> : <p class="settings-muted">{t("settings.permissions.noCapabilities")}</p>}
    </details>
  </section>;
}
