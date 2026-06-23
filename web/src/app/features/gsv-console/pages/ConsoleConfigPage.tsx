import { useState } from "preact/hooks";
import { AddAction } from "../../../components/ui/AddAction";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { TagTone } from "../../../components/ui/Tag";
import {
  ConsoleDetailPage,
  type ConsoleDetailRow,
  type ConsoleDetailSection,
} from "../components/ConsoleDetailPage";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  defaultModelLabelForConfig,
  modelConfigEntries,
  overrideConfigEntries,
  overrideConfigCount,
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
  detailBlurb: string;
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
  const [creating, setCreating] = useState(false);
  const rows = kind === "models" ? modelRows(config) : overrideRows(config);
  const title = kind === "models" ? "MODELS" : "OVERRIDES";
  const modelCount = kind === "models" ? modelConfigEntries(config).length : 0;
  const overrideCount = kind === "overrides" ? overrideConfigCount(config) : 0;
  const meta = kind === "models"
    ? `${modelCount} MODEL ${modelCount === 1 ? "SETTING" : "SETTINGS"}`
    : `${overrideCount} CONFIG ${overrideCount === 1 ? "ENTRY" : "ENTRIES"}`;
  const selectedRow = selectedRowId ? rows.find((row) => row.id === selectedRowId) ?? null : null;

  if (creating) {
    return (
      <ConfigCreatePanel
        kind={kind}
        onBack={() => setCreating(false)}
      />
    );
  }

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
          <div class="gsv-console-config-list-row" key={row.id}>
            <ListRow
              icon={row.icon}
              label={row.label}
              sub={row.sub}
              status={listRowStatusForTone(row.tone)}
              statusDotPlacement="trailing"
              statusLabel={row.statusLabel}
              tag={row.tag?.label}
              tagTone={row.tag?.tone}
              chevron
              onClick={() => {
                setCreating(false);
                setSelectedRowId(row.id);
              }}
            />
          </div>
        ))}
        {kind === "models" ? (
          <div class="gsv-console-config-list-add">
            <AddAction
              label="NEW MODEL"
              onClick={() => {
                setSelectedRowId(null);
                setCreating(true);
              }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ConfigCreatePanel({
  kind,
  onBack,
}: {
  kind: ConsoleConfigKind;
  onBack: () => void;
}) {
  const isModel = kind === "models";

  return (
    <ConsoleDetailPage
      icon={isModel ? "stars" : "cog"}
      title={isModel ? "NEW MODEL" : "NEW CONFIG"}
      typeLabel={`GSV · ${isModel ? "MODEL" : "CONFIG"}`}
      statusLabel="DRAFT"
      tone="idle"
      blurb={isModel
        ? "Model creation is reserved for the live gateway model configuration form."
        : "Configuration creation is reserved for the live gateway override form."}
      parentLabel={isModel ? "MODELS" : "OVERRIDES"}
      pendingLabel="FORM PLACEHOLDER"
      primaryLabel={isModel ? "CREATE MODEL" : "CREATE CONFIG"}
      onBack={onBack}
    />
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
    <ConsoleDetailPage
      icon={row.icon}
      title={row.label}
      typeLabel={`GSV · ${noun}`}
      statusLabel={row.statusLabel}
      tone={row.tone}
      blurb={row.detailBlurb}
      parentLabel={kind === "models" ? "MODELS" : "OVERRIDES"}
      primaryLabel="SAVE CHANGES"
      sections={configDetailSections(kind, row)}
      onBack={onBack}
    />
  );
}

function configDetailSections(kind: ConsoleConfigKind, row: ConfigRow): ConsoleDetailSection[] {
  return [
    {
      title: kind === "models" ? "MODEL" : "CONFIG",
      meta: row.statusLabel,
      rows: configDetailRows([
        configDetailRow("label", kind === "models" ? "MODEL" : "KEY", row.label),
        configDetailRow("source", kind === "models" ? "CONFIG KEY" : "VALUE", row.sub),
        configDetailRow("status", "STATUS", row.statusLabel, {
          status: listRowStatusForTone(row.tone),
          statusLabel: row.statusLabel,
        }),
      ]),
    },
  ];
}

function configDetailRow(
  id: string,
  label: string,
  sub: string,
  options: Pick<ConsoleDetailRow, "status" | "statusLabel"> = {},
): ConsoleDetailRow | null {
  const value = sub.trim();
  return value ? { id, label, sub: value, ...options } : null;
}

function configDetailRows(rows: readonly (ConsoleDetailRow | null)[]): ConsoleDetailRow[] {
  return rows.filter((row): row is ConsoleDetailRow => row !== null);
}

function listRowStatusForTone(tone: StatusTone): ListRowStatus {
  if (tone === "online" || tone === "error" || tone === "idle" || tone === "live" || tone === "update" || tone === "warn") {
    return tone;
  }
  return "online";
}

function modelRows(config: readonly ConsoleConfigEntry[]): ConfigRow[] {
  const defaultModel = defaultModelLabelForConfig(config);
  const rows = modelConfigEntries(config).map((entry): ConfigRow => ({
    id: entry.key,
    icon: "stars",
    label: entry.value,
    sub: entry.key,
    statusLabel: entry.value === defaultModel ? "DEFAULT" : "CONFIGURED",
    tone: "online" as const,
    detailBlurb: entry.value === defaultModel
      ? "Gateway model setting currently selected as the default model for agent behavior."
      : "Gateway model setting returned by the live system configuration.",
    ...(entry.value === defaultModel ? { tag: { label: "DEFAULT", tone: "online" as const } } : {}),
  }));

  if (rows.length > 0) {
    return rows;
  }

  return [{
    id: "no-live-model-config",
    icon: "stars",
    label: "NO LIVE MODEL CONFIG",
    sub: "Gateway did not return model configuration entries.",
    statusLabel: "EMPTY",
    tone: "idle",
    detailBlurb: "No model configuration entries are currently returned by the gateway.",
  }];
}

function overrideRows(config: readonly ConsoleConfigEntry[]): ConfigRow[] {
  const overrides = overrideConfigEntries(config);

  if (overrides.length === 0) {
    return [{
      id: "no-overrides",
      icon: "cog",
      label: "NOT CONFIGURED",
      sub: "No system config entries are currently returned by the gateway.",
      statusLabel: "EMPTY",
      tone: "idle",
      detailBlurb: "No override entries are currently returned by the gateway.",
    }];
  }

  return [...overrides]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry): ConfigRow => {
      const hasValue = entry.value.trim().length > 0;
      return {
        id: entry.key,
        icon: "cog",
        label: entry.key,
        sub: entry.redacted ? "redacted value" : hasValue ? entry.value : "empty value",
        statusLabel: entry.redacted ? "REDACTED" : hasValue ? "CONFIGURED" : "EMPTY",
        tone: entry.redacted ? "update" : hasValue ? "online" : "idle",
        detailBlurb: entry.redacted
          ? "This override is present but its value is redacted by the gateway."
          : hasValue
            ? "This override is present in the live gateway configuration."
            : "This override is present but currently has an empty value.",
        ...(entry.redacted ? { tag: { label: "REDACTED", tone: "warn" as const } } : {}),
      };
    });
}
