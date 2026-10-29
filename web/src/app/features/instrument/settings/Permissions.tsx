import { saveApprovalPolicy } from "./permissionService";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleConfig, loadConsoleTargets } from "../../../services/system/consoleService";
import { APPROVAL_ACTIONS, actionLabel, humanToolCapabilityLabel, targetOptionValue, targetFromOptionValue } from "../../../components/ui/agentToolApprovalOptions";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { InfoTip } from "../../../components/ui/InfoTip";
import { Select } from "../../../components/ui/Select";
import { LoadingState } from "../../../components/ui/Spinner";
import { Table, type TableColumn } from "../../../components/ui/Table";
import { Hint } from "../../../components/ui/Tooltip";
import { defaultApprovalPolicyForConfig } from "../../../domain/system/consoleAgentBehavior";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { canConfigure, readSettingsPolicy, settingsAction, settingsPolicySchema, SETTINGS_CONFIG_KEY, type SettingsPolicy } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";
import { permissionOptionsForRule } from "./permissionModel";
import { useT } from "../../../i18n/locale";

export function Permissions({ account, active, onDirty }: SettingsSectionProps) {
  const t = useT();
  const actionOptions = APPROVAL_ACTIONS.map((action) => ({ label: actionLabel(action), value: action }));
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
  const ruleRows = (policy?.rules ?? []).map((rule, index) => ({ rule, index, options: permissionOptionsForRule(rule, targets) }));
  type RuleRow = (typeof ruleRows)[number];
  const setRule = (index: number, next: SettingsPolicy["rules"][number]) => {
    if (policy) update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? next : entry) });
  };
  const ruleColumns: TableColumn<RuleRow>[] = [
    {
      key: "tool", header: t("settings.permissions.tool"), phone: "title",
      text: ({ rule, options }) => `${humanToolCapabilityLabel(rule.match)} ${options.customToolLabel ?? ""}`,
      cell: ({ rule, index, options }) => <span class="settings-rule-cell">
        <Select block size="small" ariaLabel={t("settings.permissions.ruleTool", { number: index + 1 })} options={options.tools} selected={rule.match} placeholder={t("settings.permissions.chooseTool")} disabled={usesDefault} onSelect={(value) => setRule(index, { ...rule, match: value })} />
        <span class="settings-rule-info">{options.customToolLabel && <InfoTip text={options.customToolLabel} />}</span>
      </span>,
    },
    {
      key: "target", header: t("settings.permissions.target"),
      text: ({ rule, options }) => options.targets.find((option) => option.value === targetOptionValue(rule.target))?.label ?? "",
      cell: ({ rule, index, options }) => <Select block size="small" ariaLabel={t("settings.permissions.ruleTarget", { number: index + 1 })} options={options.targets} selected={targetOptionValue(rule.target)} disabled={usesDefault} onSelect={(value) => {
        const target = targetFromOptionValue(value);
        const next: SettingsPolicy["rules"][number] = { match: rule.match, action: rule.action };
        if (target) next.target = target;
        setRule(index, next);
      }} />,
    },
    {
      key: "action", header: t("settings.permissions.action"),
      text: ({ rule }) => actionLabel(rule.action),
      cell: ({ rule, index }) => <Select block size="small" ariaLabel={t("settings.permissions.ruleAction", { number: index + 1 })} options={actionOptions} selected={rule.action} disabled={usesDefault} onSelect={(value) => setRule(index, { ...rule, action: settingsAction(value) })} />,
    },
  ];
  return <section class="settings-permissions" aria-labelledby="settings-permissions-title">
    <h1 id="settings-permissions-title">{t("settings.permissions.title")}</h1>
    <p class="settings-intro">{t("settings.permissions.intro")}</p>
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
          <Table caption={t("settings.permissions.rules")} rows={ruleRows} rowId={(entry) => `rule-${entry.index}`} columns={ruleColumns} density="compact"
            search={{ label: t("settings.permissions.searchRules"), placeholder: t("settings.permissions.searchRules") }}
            reorder={{ disabled: usesDefault, label: (entry) => t("settings.permissions.rule", { number: entry.index + 1 }), onMove: (from, to) => {
              const rules = [...policy.rules];
              const [moving] = rules.splice(from, 1);
              rules.splice(to, 0, moving);
              update({ ...policy, rules });
            } }}
            rowActions={(entry) => <Hint text={t("settings.permissions.removeRule")}>
              <IconButton glyph="delete" variant="floating" ariaLabel={`${t("settings.permissions.removeRule")}: ${t("settings.permissions.rule", { number: entry.index + 1 })}`} disabled={usesDefault}
                onClick={() => update({ ...policy, rules: policy.rules.filter((_, at) => at !== entry.index) })} />
            </Hint>}
            empty={<p>{t("settings.permissions.noRules")}</p>} />
          <div class="settings-actions">
            <Button variant="secondary" label={t("settings.permissions.addRule")} disabled={usesDefault} onClick={() => update({ ...policy, rules: [...policy.rules, { match: "", action: "ask" }] })} />
            <Button variant="primary" type="submit" label={save.isPending ? t("common.saving") : t("settings.permissions.save")} disabled={!dirty || save.isPending} />
            {dirty && <Button variant="link" label={t("common.discardChanges")} onClick={() => { setDraft(null); setError(null); save.reset(); }} />}
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
