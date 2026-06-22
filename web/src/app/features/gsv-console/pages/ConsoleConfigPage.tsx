import { useState } from "preact/hooks";
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
  overrideConfigEntries,
  overrideConfigCount,
} from "../domain/consoleAi";
import type { ConsoleConfigEntry } from "../domain/consoleModels";
import { useConsoleConfig } from "../hooks/useConsoleData";
import {
  ConsoleDetailChips,
  ConsoleDetailGrid,
  type ConsoleDetailChip,
  type ConsoleDetailField,
} from "./ConsoleDetailBlocks";
import "./ConsoleConfigPage.css";

export type ConsoleConfigKind = "models" | "overrides";

type ConfigRow = {
  id: string;
  label: string;
  sub: string;
  statusLabel: string;
  tone: StatusTone;
  detailBlurb: string;
  fields: readonly ConsoleDetailField[];
  chips: readonly ConsoleDetailChip[];
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
    <ConsolePage flush>
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
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const rows = kind === "models" ? modelRows(config) : overrideRows(config);
  const title = kind === "models" ? "MODELS" : "OVERRIDES";
  const modelCount = kind === "models" ? modelConfigEntries(config).length : 0;
  const overrideCount = kind === "overrides" ? overrideConfigCount(config) : 0;
  const meta = kind === "models"
    ? `${modelCount} MODEL ${modelCount === 1 ? "SETTING" : "SETTINGS"}`
    : `${overrideCount} CONFIG ${overrideCount === 1 ? "ENTRY" : "ENTRIES"}`;
  const selectedRow = selectedRowId ? rows.find((row) => row.id === selectedRowId) ?? null : null;

  if (selectedRow) {
    return (
      <ConfigDetailPanel
        kind={kind}
        row={selectedRow}
        onBack={() => setSelectedRowId(null)}
      />
    );
  }

  return (
    <section class="gsv-console-config-list">
      <SectionHeader title={title} meta={meta} divider />
      <div class="gsv-console-config-list-body">
        {rows.map((row) => (
          <button
            type="button"
            class="gsv-console-config-row"
            key={row.id}
            onClick={() => setSelectedRowId(row.id)}
          >
            <span class="gsv-console-config-row-mark">
              <StatusDot tone={row.tone} size={8} />
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
            <span class="gsv-console-config-row-open" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

function ConfigDetailPanel({
  kind,
  row,
  onBack,
}: {
  kind: ConsoleConfigKind;
  row: ConfigRow;
  onBack: () => void;
}) {
  const noun = kind === "models" ? "MODEL" : "CONFIG";

  return (
    <section class="gsv-console-config-detail">
      <div class="gsv-console-config-detail-shell">
        <header class="gsv-console-config-detail-head">
          <span class="gsv-console-config-detail-icon">
            <Icon name={kind === "models" ? "stars" : "cog"} size={30} />
          </span>
          <div class="gsv-console-config-detail-title">
            <h2>{row.label}</h2>
            <div>
              <span>GSV · {noun}</span>
              <StatusDot tone={row.tone} size={7} />
              <span>{row.statusLabel}</span>
            </div>
          </div>
        </header>
        <p class="gsv-console-config-detail-blurb">{row.detailBlurb}</p>
        <div class="gsv-console-config-detail-panel">
          <span class="gsv-detail-corner is-top-left" aria-hidden="true" />
          <span class="gsv-detail-corner is-top-right" aria-hidden="true" />
          <span class="gsv-detail-corner is-bottom-left" aria-hidden="true" />
          <span class="gsv-detail-corner is-bottom-right" aria-hidden="true" />
          <ConsoleDetailGrid fields={row.fields} />
          <ConsoleDetailChips title="STATE" emptyLabel="NO STATE" chips={row.chips} />
        </div>
        <div class="gsv-console-config-detail-actions">
          <button type="button" class="gsv-console-config-detail-back" onClick={onBack}>
            BACK TO {kind === "models" ? "MODELS" : "OVERRIDES"}
          </button>
        </div>
      </div>
    </section>
  );
}

function modelRows(config: readonly ConsoleConfigEntry[]): ConfigRow[] {
  const defaultModel = defaultModelLabelForConfig(config);
  const rows = modelConfigEntries(config).map((entry): ConfigRow => ({
    id: entry.key,
    label: entry.value,
    sub: entry.key,
    statusLabel: entry.value === defaultModel ? "DEFAULT" : "CONFIGURED",
    tone: "online" as const,
    detailBlurb: entry.value === defaultModel
      ? "Gateway model setting currently selected as the default model for agent behavior."
      : "Gateway model setting returned by the live system configuration.",
    fields: [
      { label: "CONFIG KEY", value: entry.key, wide: true },
      { label: "MODEL", value: entry.value, wide: true },
      { label: "DEFAULT", value: entry.value === defaultModel ? "YES" : "NO", tone: entry.value === defaultModel ? "online" : "idle" },
      { label: "SOURCE", value: "GATEWAY CONFIG" },
    ],
    chips: [
      { label: entry.value === defaultModel ? "DEFAULT" : "CONFIGURED", tone: entry.value === defaultModel ? "online" : "accent" },
      { label: "LIVE CONFIG", tone: "info" },
    ],
    ...(entry.value === defaultModel ? { tag: { label: "DEFAULT", tone: "online" as const } } : {}),
  }));

  if (rows.length > 0) {
    return rows;
  }

  return [{
    id: "gateway-default-model",
    label: DEFAULT_MODEL_LABEL,
    sub: "No model override is configured; gateway defaults apply.",
    statusLabel: "DEFAULT",
    tone: "idle",
    detailBlurb: "No model override is currently returned by the gateway. The displayed model is inferred from the application default.",
    fields: [
      { label: "MODEL", value: DEFAULT_MODEL_LABEL, wide: true },
      { label: "CONFIG KEY", value: "NOT CONFIGURED", wide: true },
      { label: "DEFAULT", value: "YES", tone: "idle" },
      { label: "SOURCE", value: "INFERRED" },
    ],
    chips: [
      { label: "INFERRED", tone: "idle" },
      { label: "NO OVERRIDE", tone: "idle" },
    ],
    tag: { label: "INFERRED", tone: "idle" },
  }];
}

function overrideRows(config: readonly ConsoleConfigEntry[]): ConfigRow[] {
  const overrides = overrideConfigEntries(config);

  if (overrides.length === 0) {
    return [{
      id: "no-overrides",
      label: "NOT CONFIGURED",
      sub: "No system config entries are currently returned by the gateway.",
      statusLabel: "EMPTY",
      tone: "idle",
      detailBlurb: "No override entries are currently returned by the gateway.",
      fields: [
        { label: "STATE", value: "EMPTY", tone: "idle" },
        { label: "CONFIG ENTRIES", value: "0" },
      ],
      chips: [
        { label: "NO OVERRIDES", tone: "idle" },
      ],
    }];
  }

  return [...overrides]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry): ConfigRow => {
      const hasValue = entry.value.trim().length > 0;
      return {
        id: entry.key,
        label: entry.key,
        sub: entry.redacted ? "redacted value" : hasValue ? entry.value : "empty value",
        statusLabel: entry.redacted ? "REDACTED" : hasValue ? "CONFIGURED" : "EMPTY",
        tone: entry.redacted ? "update" : hasValue ? "online" : "idle",
        detailBlurb: entry.redacted
          ? "This override is present but its value is redacted by the gateway."
          : hasValue
            ? "This override is present in the live gateway configuration."
            : "This override is present but currently has an empty value.",
        fields: [
          { label: "CONFIG KEY", value: entry.key, wide: true },
          { label: "VALUE", value: entry.redacted ? "REDACTED" : entry.value, tone: entry.redacted ? "warn" : hasValue ? "online" : "idle", wide: true },
          { label: "REDACTED", value: entry.redacted ? "YES" : "NO", tone: entry.redacted ? "warn" : "idle" },
          { label: "STATE", value: entry.redacted ? "REDACTED" : hasValue ? "CONFIGURED" : "EMPTY", tone: entry.redacted ? "warn" : hasValue ? "online" : "idle" },
        ],
        chips: [
          { label: entry.redacted ? "REDACTED" : hasValue ? "CONFIGURED" : "EMPTY", tone: entry.redacted ? "warn" : hasValue ? "online" : "idle" },
          { label: "LIVE CONFIG", tone: "info" },
        ],
        ...(entry.redacted ? { tag: { label: "REDACTED", tone: "warn" as const } } : {}),
      };
    });
}
