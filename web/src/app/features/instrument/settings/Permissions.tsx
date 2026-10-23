import { saveApprovalPolicy } from "./permissionService";
import { isToolApprovalTargetSelector } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleConfig, loadConsoleTargets } from "../../../services/system/consoleService";
import { APPROVAL_ACTIONS, actionLabel, humanToolCapabilityLabel, targetOptionValue, targetFromOptionValue } from "../../../components/ui/agentToolApprovalOptions";
import { LoadingState } from "../../../components/ui/Spinner";
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
  const update = (next: SettingsPolicy) => { setDraft({ inherited: false, policy: next, base: draft?.base ?? original }); setSaved(false); setError(null); };
  return <section class="settings-permissions" aria-labelledby="settings-permissions-title">
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
          <label>{t("settings.permissions.default")}<select value={policy.default} disabled={usesDefault} onChange={(event) => update({ ...policy, default: settingsAction(event.currentTarget.value) })}>
            {APPROVAL_ACTIONS.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}
          </select></label>
          <ol class="settings-rules">{policy.rules.map((rule, index) => {
            const options = permissionOptionsForRule(rule, targets);
            return <li key={index}>
            <div class="settings-rule-move">
              <button class="settings-text-action" type="button" aria-label={t("settings.permissions.moveUp")} title={t("settings.permissions.moveUp")} disabled={usesDefault || index === 0} onClick={() => { const rules = [...policy.rules]; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; update({ ...policy, rules }); }}>↑</button>
              <button class="settings-text-action" type="button" aria-label={t("settings.permissions.moveDown")} title={t("settings.permissions.moveDown")} disabled={usesDefault || index === policy.rules.length - 1} onClick={() => { const rules = [...policy.rules]; [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]]; update({ ...policy, rules }); }}>↓</button>
            </div>
            <div class="settings-rule-tool"><label>{t("settings.permissions.tool")}<select aria-label={t("settings.permissions.ruleTool", { number: index + 1 })} value={rule.match} disabled={usesDefault} onChange={(event) => update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? { ...entry, match: event.currentTarget.value } : entry) })}>
              {!rule.match && <option value="" disabled>{t("settings.permissions.chooseTool")}</option>}
              {options.tools.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>{options.customToolLabel && <small>{options.customToolLabel}</small>}</label>
              <button class="settings-text-action settings-rule-remove" type="button" disabled={usesDefault} onClick={() => update({ ...policy, rules: policy.rules.filter((_, at) => at !== index) })}>{t("common.remove")}</button>
            </div>
            <label>{t("settings.permissions.target")}<select aria-label={t("settings.permissions.ruleTarget", { number: index + 1 })} value={targetOptionValue(rule.target)} disabled={usesDefault} onChange={(event) => {
              const target = targetFromOptionValue(event.currentTarget.value);
              const next: SettingsPolicy["rules"][number] = { match: rule.match, action: rule.action };
              if (target) next.target = target;
              update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? next : entry) });
            }}>{options.targets.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{rule.target && !isToolApprovalTargetSelector(rule.target) && <small>{rule.target}</small>}</label>
            <label>{t("settings.permissions.action")}<select aria-label={t("settings.permissions.ruleAction", { number: index + 1 })} value={rule.action} disabled={usesDefault} onChange={(event) => update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? { ...entry, action: settingsAction(event.currentTarget.value) } : entry) })}>{APPROVAL_ACTIONS.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}</select></label>

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
