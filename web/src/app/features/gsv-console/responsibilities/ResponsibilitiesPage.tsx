import type {
  ResponsibilityRecord,
  ResponsibilitySourcePolicy,
  ScheduleExpression,
  ScheduleRecord,
} from "@humansandmachines/gsv/protocol";
import { useMemo, useState } from "preact/hooks";
import * as z from "zod/mini";

import { Button } from "../../../components/ui/Button";
import { Tabs } from "../../../components/ui/Tabs";
import { Toggle } from "../../../components/ui/Toggle";
import { ConsolePage, ConsolePageState } from "../components/ConsolePageTemplate";
import { useResponsibilitiesWorkspace } from "./useResponsibilitiesWorkspace";
import type { ResponsibilityWorkspaceMutation } from "./responsibilitiesService";
import "./ResponsibilitiesPage.css";

const TAB_NAMES = ["OPEN", "STANDING", "HISTORY"];
const EVERY_UNITS = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
} as const;
type EveryUnit = keyof typeof EVERY_UNITS;
type EditorState = {
  id?: string;
  name: string;
  instructions: string;
  mode: "every" | "cron";
  interval: string;
  unit: EveryUnit;
  cron: string;
  timezone: string;
  enabled: boolean;
};

const EMPTY_EDITOR: EditorState = {
  name: "",
  instructions: "",
  mode: "every",
  interval: "1",
  unit: "days",
  cron: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
};
const responsibilityTextSchema = z.string();

export function ResponsibilitiesPage() {
  const [tab, setTab] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const { connected, query, mutation } = useResponsibilitiesWorkspace();
  const busy = mutation.isPending;

  if (!connected) return <ConsolePageState kind="offline" detail="CONNECTION REQUIRED" />;
  if (query.isLoading) return <ConsolePageState kind="loading" label="LOADING RESPONSIBILITIES" />;
  if (query.isError || !query.data) {
    return <ConsolePageState kind="error" detail={query.error?.message ?? "RESPONSIBILITIES"} />;
  }

  const data = query.data;
  return (
    <ConsolePage className="gsv-r12y-page">
      <div class="gsv-r12y-shell">
        <header class="gsv-r12y-header">
          <div>
            <span class="gsv-sublabel">SHIP RESPONSIBILITIES</span>
            <h1>What GSV owns</h1>
            <p>Current obligations, standing sources, recurring routines, and completed work.</p>
          </div>
          <span class="gsv-r12y-revision">
            {data.open.length} OPEN · {data.schedules.length + data.sources.length} STANDING
          </span>
        </header>
        <Tabs tabs={TAB_NAMES} value={tab} onChange={(next) => {
          setTab(next);
          setEditor(null);
        }} />
        {mutation.error ? <div class="gsv-r12y-error" role="alert">{mutation.error.message}</div> : null}
        {tab === 0 ? <ResponsibilityList records={data.open} empty="NOTHING NEEDS ATTENTION" /> : null}
        {tab === 1 ? (
          <StandingPanel
            editor={editor}
            schedules={data.schedules}
            sources={data.sources}
            busy={busy}
            onEdit={setEditor}
            onCancelEdit={() => setEditor(null)}
            onMutation={(input) => mutation.mutate(input, {
              onSuccess: () => setEditor(null),
            })}
          />
        ) : null}
        {tab === 2 ? <ResponsibilityList records={data.history} empty="NO COMPLETED RESPONSIBILITIES YET" /> : null}
      </div>
    </ConsolePage>
  );
}

function ResponsibilityList({ records, empty }: { records: ResponsibilityRecord[]; empty: string }) {
  if (records.length === 0) return <div class="gsv-r12y-empty">{empty}</div>;
  return (
    <div class="gsv-r12y-list">
      {records.map((record) => (
        <article class="gsv-r12y-card" key={record.id}>
          <div class="gsv-r12y-card-heading">
            <span class={`gsv-r12y-state is-${record.state}`}>{record.state.toUpperCase()}</span>
            <span>{record.priority.toUpperCase()}</span>
            <time dateTime={new Date(record.updatedAtMs).toISOString()}>{formatTimestamp(record.updatedAtMs)}</time>
          </div>
          <h2>{record.title}</h2>
          <p>{responsibilityDetail(record)}</p>
          <code>{record.id}</code>
        </article>
      ))}
    </div>
  );
}

function StandingPanel({
  busy,
  editor,
  schedules,
  sources,
  onCancelEdit,
  onEdit,
  onMutation,
}: {
  busy: boolean;
  editor: EditorState | null;
  schedules: ScheduleRecord[];
  sources: ResponsibilitySourcePolicy[];
  onCancelEdit: () => void;
  onEdit: (editor: EditorState) => void;
  onMutation: (input: ResponsibilityWorkspaceMutation) => void;
}) {
  return (
    <div class="gsv-r12y-standing">
      <section>
        <div class="gsv-r12y-section-heading">
          <div><span class="gsv-sublabel">BUILT IN</span><h2>System responsibilities</h2></div>
        </div>
        <div class="gsv-r12y-list">
          {sources.map((source) => (
            <article class="gsv-r12y-card is-standing" key={source.id}>
              <div>
                <h2>{source.name}</h2>
                <p>{source.description}</p>
              </div>
              {source.control === "required" ? (
                <span class="gsv-r12y-required">ALWAYS ON</span>
              ) : (
                <Toggle
                  label={source.enabled ? "ENABLED" : "DISABLED"}
                  on={source.enabled}
                  disabled={busy}
                  onChange={(enabled) => onMutation({ kind: "source", id: source.id, enabled })}
                />
              )}
            </article>
          ))}
        </div>
      </section>
      <section>
        <div class="gsv-r12y-section-heading">
          <div><span class="gsv-sublabel">CUSTOM</span><h2>Recurring routines</h2></div>
          {!editor ? <Button label="NEW ROUTINE" onClick={() => onEdit({ ...EMPTY_EDITOR })} /> : null}
        </div>
        {editor ? (
          <RoutineEditor
            value={editor}
            busy={busy}
            onChange={onEdit}
            onCancel={onCancelEdit}
            onSave={(value) => onMutation({
              kind: "schedule.save",
              input: {
                id: value.id,
                name: value.name.trim(),
                instructions: value.instructions.trim(),
                expression: editorExpression(value),
                enabled: value.enabled,
              },
            })}
          />
        ) : null}
        <div class="gsv-r12y-list">
          {schedules.length === 0 && !editor ? <div class="gsv-r12y-empty">NO CUSTOM ROUTINES</div> : null}
          {schedules.map((schedule) => (
            <article class="gsv-r12y-card is-standing" key={schedule.id}>
              <div>
                <h2>{schedule.name}</h2>
                <p>{schedule.target.kind === "responsibility" ? schedule.target.message : ""}</p>
                <div class="gsv-r12y-schedule-meta">
                  <span class="gsv-r12y-cadence">{formatExpression(schedule.expression)}</span>
                  <span>{formatNextOccurrence(schedule)}</span>
                </div>
              </div>
              <div class="gsv-r12y-actions">
                <Toggle
                  label={schedule.enabled ? "ENABLED" : "DISABLED"}
                  on={schedule.enabled}
                  disabled={busy}
                  onChange={(enabled) => onMutation({ kind: "schedule.toggle", id: schedule.id, enabled })}
                />
                <Button variant="secondary" label="EDIT" disabled={busy} onClick={() => onEdit(editorForSchedule(schedule))} />
                <Button variant="dangerGhost" label="DELETE" disabled={busy} onClick={() => onMutation({ kind: "schedule.remove", id: schedule.id })} />
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function RoutineEditor({ value, busy, onChange, onCancel, onSave }: {
  value: EditorState;
  busy: boolean;
  onChange: (value: EditorState) => void;
  onCancel: () => void;
  onSave: (value: EditorState) => void;
}) {
  const valid = useMemo(() => {
    if (!value.name.trim() || !value.instructions.trim()) return false;
    if (value.mode === "cron") return Boolean(value.cron.trim() && value.timezone.trim());
    return Number.isFinite(Number(value.interval)) && Number(value.interval) > 0;
  }, [value]);
  return (
    <form class="gsv-r12y-editor" onSubmit={(event) => {
      event.preventDefault();
      if (valid && !busy) onSave(value);
    }}>
      <label>NAME<input value={value.name} onInput={(event) => onChange({ ...value, name: event.currentTarget.value })} /></label>
      <label>INSTRUCTIONS<textarea rows={4} value={value.instructions} onInput={(event) => onChange({ ...value, instructions: event.currentTarget.value })} /></label>
      <div class="gsv-r12y-editor-row">
        <label>CADENCE<select value={value.mode} onChange={(event) => onChange({ ...value, mode: editorMode(event.currentTarget.value) })}><option value="every">EVERY</option><option value="cron">CRON</option></select></label>
        {value.mode === "every" ? (
          <><label>INTERVAL<input type="number" min="1" value={value.interval} onInput={(event) => onChange({ ...value, interval: event.currentTarget.value })} /></label><label>UNIT<select value={value.unit} onChange={(event) => onChange({ ...value, unit: everyUnit(event.currentTarget.value) })}>{Object.keys(EVERY_UNITS).map((unit) => <option value={unit} key={unit}>{unit.toUpperCase()}</option>)}</select></label></>
        ) : (
          <><label>CRON<input value={value.cron} onInput={(event) => onChange({ ...value, cron: event.currentTarget.value })} /></label><label>TIMEZONE<input value={value.timezone} onInput={(event) => onChange({ ...value, timezone: event.currentTarget.value })} /></label></>
        )}
      </div>
      <Toggle label="ENABLED" on={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
      <div class="gsv-r12y-editor-actions"><Button type="submit" label={value.id ? "SAVE ROUTINE" : "CREATE ROUTINE"} disabled={!valid || busy} /><Button variant="secondary" label="CANCEL" disabled={busy} onClick={onCancel} /></div>
    </form>
  );
}

function editorExpression(value: EditorState): ScheduleExpression {
  if (value.mode === "cron") return { kind: "cron", expr: value.cron.trim(), timezone: value.timezone.trim() };
  return { kind: "every", everyMs: Math.round(Number(value.interval) * EVERY_UNITS[value.unit]) };
}

function editorForSchedule(schedule: ScheduleRecord): EditorState {
  const target = schedule.target.kind === "responsibility" ? schedule.target.message : "";
  if (schedule.expression.kind === "cron") return { id: schedule.id, name: schedule.name, instructions: target, mode: "cron", interval: "1", unit: "days", cron: schedule.expression.expr, timezone: schedule.expression.timezone, enabled: schedule.enabled };
  const everyMs = schedule.expression.kind === "every" ? schedule.expression.everyMs : 86_400_000;
  const unit: EveryUnit = everyMs % EVERY_UNITS.days === 0 ? "days" : everyMs % EVERY_UNITS.hours === 0 ? "hours" : "minutes";
  return { id: schedule.id, name: schedule.name, instructions: target, mode: "every", interval: String(everyMs / EVERY_UNITS[unit]), unit, cron: "0 9 * * *", timezone: "UTC", enabled: schedule.enabled };
}

function formatExpression(expression: ScheduleExpression): string {
  if (expression.kind === "cron") return `${expression.expr} · ${expression.timezone}`;
  if (expression.kind === "every") return `EVERY ${formatDuration(expression.everyMs)}`;
  if (expression.kind === "after") return `AFTER ${formatDuration(expression.afterMs)}`;
  return new Date(expression.atMs).toLocaleString();
}

function formatNextOccurrence(schedule: ScheduleRecord): string {
  if (!schedule.enabled) return "NO NEXT OCCURRENCE · DISABLED";
  if (schedule.state.nextRunAtMs === null) return "NEXT OCCURRENCE PENDING";
  return `NEXT ${formatTimestamp(schedule.state.nextRunAtMs)}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % EVERY_UNITS.days === 0) return `${milliseconds / EVERY_UNITS.days}D`;
  if (milliseconds % EVERY_UNITS.hours === 0) return `${milliseconds / EVERY_UNITS.hours}H`;
  return `${Math.max(1, Math.round(milliseconds / EVERY_UNITS.minutes))}M`;
}

function responsibilityDetail(record: ResponsibilityRecord): string {
  if (record.blocker) return record.blocker;
  const detailSummary = responsibilityTextSchema.safeParse(record.details?.summary);
  if (detailSummary.success) return detailSummary.data;
  const detailMessage = responsibilityTextSchema.safeParse(record.details?.message);
  if (detailMessage.success) return detailMessage.data;
  const resolutionSummary = responsibilityTextSchema.safeParse(record.resolution?.summary);
  if (resolutionSummary.success) return resolutionSummary.data;
  return `Assigned to ${record.assignee.kind === "ship" ? "Ship" : record.assignee.processId}.`;
}

function editorMode(value: string): EditorState["mode"] {
  return value === "cron" ? "cron" : "every";
}

function everyUnit(value: string): EveryUnit {
  if (value === "hours") return "hours";
  if (value === "days") return "days";
  return "minutes";
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
