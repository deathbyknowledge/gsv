import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleConfig, loadConsoleTargets, saveConsoleConfig } from "../../gsv-console/backend/consoleService";
import { APPROVAL_ACTIONS, actionLabel } from "../../../components/ui/agentToolApprovalOptions";
import { LoadingState } from "../../../components/ui/Spinner";
import { defaultApprovalPolicyForConfig } from "../../gsv-console/domain/consoleAgentBehavior";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { canConfigure, readSettingsPolicy, settingsAction, settingsPolicySchema, SETTINGS_CONFIG_KEY, type SettingsPolicy } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";
import { permissionOptionsForRule } from "./permissionModel";

export function Permissions({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: SETTINGS_CONFIG_KEY, queryFn: () => loadConsoleConfig(client), enabled: connected && active });
  const targetQuery = useQuery({ queryKey: INSTRUMENT_TARGETS_KEY, queryFn: () => loadConsoleTargets(client), enabled: connected && active });
  const targets = (targetQuery.data ?? []).map((target) => ({ id: target.deviceId, label: target.label }));
  const key = `users/${account.uid}/ai/tools/approval`;
  const original = config.data?.find((entry) => entry.key === key)?.value ?? "";
  const inherited = defaultApprovalPolicyForConfig(config.data ?? []);
  const [draft, setDraft] = useState<{ inherited: boolean; policy: SettingsPolicy } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const usesDefault = draft?.inherited ?? !original;
  const policy = usesDefault ? readSettingsPolicy(inherited) : draft?.policy ?? readSettingsPolicy(original);
  const nextValue = usesDefault ? "" : policy ? JSON.stringify(policy) : original;
  const dirty = draft !== null && (usesDefault ? original !== "" : JSON.stringify(readSettingsPolicy(original)) !== nextValue);
  useSettingsDirty(dirty, onDirty);
  const editable = connected && !!config.data && !config.isError && canConfigure(account, "sys.config.set") && policy !== null;
  const save = useMutation({
    mutationFn: (value: string) => saveConsoleConfig(client, { key, value }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }); setDraft(null); setSaved(true); },
  });
  const update = (next: SettingsPolicy) => { setDraft({ inherited: false, policy: next }); setSaved(false); setError(null); };
  return <section aria-labelledby="settings-permissions-title">
    <h1 id="settings-permissions-title">Permissions</h1>
    <p class="settings-intro">Choose when your agents ask before using a capability. More specific targets win, then more specific capabilities; list order breaks ties. Account capability grants still set the outer limit.</p>
    <p class="settings-muted">Mail needs an explicit Allow rule to send without asking, even when the default is Allow.</p>
    <SettingsError error={config.error ?? error ?? save.error} />
    {config.isPending && connected && <LoadingState variant="panel">Loading permissions…</LoadingState>}
    {targetQuery.error && <p class="settings-muted" role="status">Target names could not be loaded. Stored target IDs remain available.</p>}
    {config.data && !policy && <p class="settings-error" role="alert">This policy contains advanced or unrecognized fields. It is preserved unchanged; use the existing advanced settings to edit it.</p>}
    {!canConfigure(account, "sys.config.set") && <p class="settings-muted">Your account cannot change approval defaults.</p>}
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!editable || !policy) return;
      const parsed = settingsPolicySchema.safeParse(policy);
      if (!usesDefault && !parsed.success) { setError(new Error("Every rule needs a capability and a valid action. Remove surrounding spaces.")); return; }
      save.mutate(nextValue);
    }}>
      <fieldset disabled={!editable || save.isPending}>
        <label class="settings-check"><input type="checkbox" checked={usesDefault} onChange={(event) => {
          if (policy) { setDraft({ inherited: event.currentTarget.checked, policy }); setSaved(false); }
        }} />Use inherited policy</label>
        {policy && <>
          <label>When no rule matches<select value={policy.default} disabled={usesDefault} onChange={(event) => update({ ...policy, default: settingsAction(event.currentTarget.value) })}>
            {APPROVAL_ACTIONS.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}
          </select></label>
          <ol class="settings-rules">{policy.rules.map((rule, index) => {
            const options = permissionOptionsForRule(rule, targets);
            return <li key={index}>
            <label>Tool<select aria-label={`Rule ${index + 1} tool`} value={rule.match} disabled={usesDefault} onChange={(event) => update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? { ...entry, match: event.currentTarget.value } : entry) })}>
              {!rule.match && <option value="" disabled>Choose a tool</option>}
              {options.tools.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>{options.customToolLabel && <small>{options.customToolLabel}</small>}</label>
            <label>Target<select aria-label={`Rule ${index + 1} target`} value={rule.target ?? ""} disabled={usesDefault} onChange={(event) => {
              const target = event.currentTarget.value;
              const next: SettingsPolicy["rules"][number] = { match: rule.match, action: rule.action };
              if (target) next.target = target;
              update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? next : entry) });
            }}>{options.targets.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{rule.target && <small>{rule.target}</small>}</label>
            <label>Action<select aria-label={`Rule ${index + 1} action`} value={rule.action} disabled={usesDefault} onChange={(event) => update({ ...policy, rules: policy.rules.map((entry, at) => at === index ? { ...entry, action: settingsAction(event.currentTarget.value) } : entry) })}>{APPROVAL_ACTIONS.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}</select></label>
            <div class="settings-actions">
              <button class="ibtn" type="button" disabled={usesDefault || index === 0} onClick={() => { const rules = [...policy.rules]; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; update({ ...policy, rules }); }}>move up</button>
              <button class="ibtn" type="button" disabled={usesDefault} onClick={() => update({ ...policy, rules: policy.rules.filter((_, at) => at !== index) })}>remove</button>
            </div>
          </li>;
          })}</ol>
          <div class="settings-actions">
            <button class="ibtn" type="button" disabled={usesDefault} onClick={() => update({ ...policy, rules: [...policy.rules, { match: "", action: "ask" }] })}>add rule</button>
            <button class="ibtn" type="submit" disabled={!dirty}>{save.isPending ? <LoadingState>saving…</LoadingState> : "save policy"}</button>
            {dirty && <button class="ibtn" type="button" onClick={() => { setDraft(null); setError(null); }}>discard changes</button>}
            {saved && <span role="status">saved</span>}
          </div>
        </>}
      </fieldset>
    </form>
  </section>;
}
