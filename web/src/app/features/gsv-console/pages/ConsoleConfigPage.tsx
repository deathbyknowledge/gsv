import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  DEFAULT_MODEL_LABEL,
  defaultModelLabelForConfig,
  modelConfigEntries,
} from "../domain/consoleAi";
import type { ConsoleConfigEntry } from "../domain/consoleModels";
import { useConsoleConfig } from "../hooks/useConsoleData";
import "./ConsoleConfigPage.css";

export type ConsoleConfigKind = "models" | "overrides";

type ConfigRow = {
  id: string;
  icon: string;
  label: string;
  sub: string;
  statusLabel: string;
  tone: StatusTone;
  tag?: {
    label: string;
    tone: TagTone;
  };
};

type ConsoleConfigPageProps = {
  kind: ConsoleConfigKind;
};

export function ConsoleConfigPage({ kind }: ConsoleConfigPageProps) {
  const config = useConsoleConfig();

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={{ ...config.resource, isEmpty: false }}
        emptyLabel={kind === "models" ? "NO MODEL CONFIG" : "NO OVERRIDES"}
        errorLabel={kind === "models" ? "MODELS" : "OVERRIDES"}
        render={(data) => (
          <ConsoleConfigPanel config={data} kind={kind} />
        )}
      />
    </ConsolePage>
  );
}

function ConsoleConfigPanel({
  config,
  kind,
}: {
  config: readonly ConsoleConfigEntry[];
  kind: ConsoleConfigKind;
}) {
  const rows = kind === "models" ? modelRows(config) : overrideRows(config);
  const title = kind === "models" ? "MODELS" : "OVERRIDES";
  const meta = kind === "models"
    ? `${rows.length} MODEL ${rows.length === 1 ? "SETTING" : "SETTINGS"}`
    : `${rows.length} CONFIG ${rows.length === 1 ? "ENTRY" : "ENTRIES"}`;

  return (
    <section class="gsv-console-config-list">
      <SectionHeader title={title} meta={meta} divider />
      <div class="gsv-console-config-list-body">
        {rows.map((row) => (
          <div class="gsv-console-config-row" key={row.id}>
            <span class="gsv-console-config-row-mark">
              <Icon name={row.icon} size={18} />
            </span>
            <span class="gsv-console-config-row-copy">
              <strong>{row.label}</strong>
              <small>{row.sub}</small>
            </span>
            {row.tag ? (
              <span class="gsv-console-config-row-tag">
                <Tag label={row.tag.label} tone={row.tag.tone} boxed />
              </span>
            ) : null}
            <span class="gsv-console-config-row-status">
              <StatusDot tone={row.tone} size={7} />
              <span>{row.statusLabel}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function modelRows(config: readonly ConsoleConfigEntry[]): ConfigRow[] {
  const defaultModel = defaultModelLabelForConfig(config);
  const rows = modelConfigEntries(config).map((entry) => ({
    id: entry.key,
    icon: "stars",
    label: entry.value,
    sub: entry.key,
    statusLabel: entry.value === defaultModel ? "DEFAULT" : "CONFIGURED",
    tone: "online" as const,
    ...(entry.value === defaultModel ? { tag: { label: "DEFAULT", tone: "online" as const } } : {}),
  }));

  if (rows.length > 0) {
    return rows;
  }

  return [{
    id: "gateway-default-model",
    icon: "stars",
    label: DEFAULT_MODEL_LABEL,
    sub: "No model override is configured; gateway defaults apply.",
    statusLabel: "DEFAULT",
    tone: "idle",
    tag: { label: "INFERRED", tone: "idle" },
  }];
}

function overrideRows(config: readonly ConsoleConfigEntry[]): ConfigRow[] {
  if (config.length === 0) {
    return [{
      id: "no-overrides",
      icon: "cog",
      label: "NOT CONFIGURED",
      sub: "No system config entries are currently returned by the gateway.",
      statusLabel: "EMPTY",
      tone: "idle",
    }];
  }

  return [...config]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => {
      const hasValue = entry.value.trim().length > 0;
      return {
        id: entry.key,
        icon: entry.redacted ? "lock-close" : "cog",
        label: entry.key,
        sub: entry.redacted ? "redacted value" : hasValue ? entry.value : "empty value",
        statusLabel: entry.redacted ? "REDACTED" : hasValue ? "CONFIGURED" : "EMPTY",
        tone: entry.redacted ? "update" : hasValue ? "online" : "idle",
        ...(entry.redacted ? { tag: { label: "REDACTED", tone: "warn" as const } } : {}),
      };
    });
}
