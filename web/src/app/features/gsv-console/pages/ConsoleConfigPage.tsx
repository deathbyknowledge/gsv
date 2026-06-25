import { useEffect, useState } from "preact/hooks";
import { AddAction } from "../../../components/ui/AddAction";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { TagTone } from "../../../components/ui/Tag";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
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
import { useConsoleConfig, useSaveConsoleConfig } from "../hooks/useConsoleData";
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
  configKey: string | null;
  value: string;
  redacted: boolean;
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
              chevron={row.configKey !== null}
              onClick={row.configKey === null ? undefined : () => {
                setCreating(false);
                setSelectedRowId(row.id);
              }}
            />
          </div>
        ))}
        <div class="gsv-console-config-list-add">
          <AddAction
            label={kind === "models" ? "NEW MODEL SETTING" : "NEW CONFIG"}
            onClick={() => {
              setSelectedRowId(null);
              setCreating(true);
            }}
          />
        </div>
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
  const saveConfig = useSaveConsoleConfig();
  const [configKey, setConfigKey] = useState("");
  const [value, setValue] = useState("");
  const [errorText, setErrorText] = useState("");
  const normalizedKey = configKey.trim();
  const saving = saveConfig.isPending;
  const sensitive = isSensitiveConfigKey(normalizedKey);
  const canSave = normalizedKey.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) {
      return;
    }

    setErrorText("");
    try {
      await saveConfig.mutateAsync({ key: normalizedKey, value });
      onBack();
    } catch (error) {
      setErrorText(errorMessage(error));
    }
  };

  return (
    <ConsoleDetailPage
      icon={isModel ? "stars" : "cog"}
      title={isModel ? "NEW MODEL SETTING" : "NEW CONFIG"}
      typeLabel={`GSV · ${isModel ? "MODEL SETTING" : "CONFIG"}`}
      statusLabel="DRAFT"
      tone="idle"
      blurb={isModel
        ? "Create a gateway model configuration entry."
        : "Create a gateway configuration entry."}
      parentLabel={isModel ? "MODELS" : "OVERRIDES"}
      primaryLabel={saving ? "SAVING" : isModel ? "CREATE SETTING" : "CREATE CONFIG"}
      onPrimary={canSave ? () => {
        void handleSave();
      } : undefined}
      onBack={onBack}
    >
      <div class="gsv-console-config-form">
        <TextInput
          label="CONFIG KEY"
          placeholder={isModel ? "config/ai/model" : "config/shell/timeout_ms"}
          requirement="required"
          value={configKey}
          disabled={saving}
          clearable
          status={errorText ? "error" : "none"}
          message={errorText}
          onChange={(next) => {
            setErrorText("");
            setConfigKey(next);
          }}
        />
        {sensitive ? (
          <TextInput
            key={`new-secret-${normalizedKey}`}
            label="VALUE"
            placeholder="replacement value"
            type="password"
            value={value}
            disabled={saving}
            onChange={(next) => {
              setErrorText("");
              setValue(next);
            }}
          />
        ) : (
          <TextArea
            label="VALUE"
            placeholder={isModel ? "provider/model-name" : "value"}
            rows={configValueRows(value)}
            value={value}
            disabled={saving}
            onChange={(next) => {
              setErrorText("");
              setValue(next);
            }}
          />
        )}
      </div>
    </ConsoleDetailPage>
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
  const saveConfig = useSaveConsoleConfig();
  const initialValue = row.redacted ? "" : row.value;
  const [draftValue, setDraftValue] = useState(initialValue);
  const [errorText, setErrorText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [redactedVersion, setRedactedVersion] = useState(0);
  const saving = saveConfig.isPending;
  const hasReplacement = draftValue.length > 0;
  const dirty = row.redacted ? hasReplacement : draftValue !== row.value;
  const canSave = row.configKey !== null && dirty && !saving;
  const status = errorText ? "error" : savedText ? "success" : row.redacted && !hasReplacement ? "warning" : "none";
  const message = errorText || savedText || (row.redacted && !hasReplacement ? "ENTER A REPLACEMENT VALUE" : "");

  useEffect(() => {
    setDraftValue(row.redacted ? "" : row.value);
    setErrorText("");
    setSavedText("");
    setRedactedVersion((version) => version + 1);
    saveConfig.reset();
  }, [row.id, row.redacted, row.value]);

  const handleSave = async () => {
    if (!canSave || row.configKey === null) {
      return;
    }

    setErrorText("");
    setSavedText("");
    try {
      await saveConfig.mutateAsync({ key: row.configKey, value: draftValue });
      setSavedText("SAVED");
      if (row.redacted) {
        setDraftValue("");
        setRedactedVersion((version) => version + 1);
      }
    } catch (error) {
      setErrorText(errorMessage(error));
    }
  };

  return (
    <ConsoleDetailPage
      icon={row.icon}
      title={row.label}
      typeLabel={`GSV · ${noun}`}
      statusLabel={row.statusLabel}
      tone={row.tone}
      blurb={row.detailBlurb}
      parentLabel={kind === "models" ? "MODELS" : "OVERRIDES"}
      primaryLabel={saving ? "SAVING" : "SAVE CHANGES"}
      onPrimary={canSave ? () => {
        void handleSave();
      } : undefined}
      onBack={onBack}
    >
      <div class="gsv-console-config-form">
        <TextInput
          key={`key-${row.id}`}
          label="CONFIG KEY"
          value={row.configKey ?? ""}
          readonly
        />
        {row.redacted ? (
          <TextInput
            key={`secret-${row.id}-${redactedVersion}`}
            label="VALUE"
            placeholder="replacement value"
            type="password"
            value={draftValue}
            status={status}
            message={message}
            disabled={saving}
            onChange={(next) => {
              setErrorText("");
              setSavedText("");
              setDraftValue(next);
            }}
          />
        ) : (
          <TextArea
            label="VALUE"
            placeholder="value"
            rows={configValueRows(draftValue)}
            value={draftValue}
            status={status}
            message={message}
            disabled={saving}
            onChange={(next) => {
              setErrorText("");
              setSavedText("");
              setDraftValue(next);
            }}
          />
        )}
      </div>
    </ConsoleDetailPage>
  );
}

function listRowStatusForTone(tone: StatusTone): ListRowStatus {
  if (tone === "online" || tone === "error" || tone === "idle" || tone === "live" || tone === "update" || tone === "warn") {
    return tone;
  }
  return "online";
}

const SENSITIVE_CONFIG_KEY_RE = /(?:^|\/|_)(?:api[_-]?key|password|secret|token|credential)(?:$|\/|_)/i;

function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEY_RE.test(key);
}

function configValueRows(value: string): number {
  if (value.includes("\n")) {
    return 8;
  }
  return value.length > 120 ? 6 : 4;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "Unable to save config.";
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
    configKey: entry.key,
    value: entry.value,
    redacted: entry.redacted,
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
    configKey: null,
    value: "",
    redacted: false,
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
      configKey: null,
      value: "",
      redacted: false,
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
        configKey: entry.key,
        value: entry.value,
        redacted: entry.redacted,
        ...(entry.redacted ? { tag: { label: "REDACTED", tone: "warn" as const } } : {}),
      };
    });
}
