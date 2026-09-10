import type { ScheduleRecord } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_ROUTINES_KEY } from "../wire/queryKeys";
import { useDraftGuard } from "../shared/useDraftGuard";
import { routineDraft, routineInput, routinePatch, routineSettings } from "./routineModel";
import { loadConsoleConfig, loadConsoleAccounts } from "../../../services/system/consoleService";
import { SETTINGS_CONFIG_KEY } from "../settings/settingsModel";

type RoutineEditorProps = {
  original?: ScheduleRecord;
  onSaved: (id: string) => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
};

export function RoutineEditor(props: RoutineEditorProps) {
  const { client, connected } = useGateway();
  const config = useQuery({ queryKey: SETTINGS_CONFIG_KEY, queryFn: () => loadConsoleConfig(client), enabled: connected });
  const accounts = useQuery({ queryKey: ["fleet", "accounts"], queryFn: () => loadConsoleAccounts(client), enabled: connected });
  const uid = accounts.data?.find((account) => account.relation === "self")?.uid;
  const timezone = config.data?.find((entry) => entry.key === `users/${uid}/locale/timezone`)?.value
    || config.data?.find((entry) => entry.key === "config/server/timezone")?.value || "UTC";
  if ((!config.data && config.error) || (!accounts.data && accounts.error)) return <p class="error" role="alert">{(config.error ?? accounts.error)?.message}</p>;
  if (config.isPending || accounts.isPending) return <LoadingState>Loading routine settings…</LoadingState>;
  return <RoutineEditorForm {...props} timezone={timezone} />;
}

function RoutineEditorForm({ original, onSaved, onCancel, onDirty, timezone }: RoutineEditorProps & { timezone: string }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [baseline] = useState(() => routineDraft(original, timezone));
  const [draft, setDraft] = useState(baseline);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const save = useMutation({
    mutationFn: async () => {
      const input = routineInput(draft, original);
      if (!original) return client.sched.add(input);
      // A routine can run while this form is open. Only an edited definition conflicts.
      let current: ScheduleRecord | undefined;
      for (let offset = 0; ; offset += 500) {
        const page = await client.sched.list({ includeDisabled: true, limit: 500, offset });
        current = page.schedules.find((entry) => entry.id === original.id);
        if (current || offset + page.schedules.length >= page.count || page.schedules.length === 0) break;
      }
      if (!current || routineSettings(current) !== routineSettings(original)) throw new Error("This routine changed while you were editing. Your draft is kept; reopen it to use the latest settings.");
      return client.sched.update({ id: original.id, patch: routinePatch(input) });
    },
    onSuccess: async ({ schedule }) => { await cache.invalidateQueries({ queryKey: INSTRUMENT_ROUTINES_KEY }); onSaved(schedule.id); },
  });
  useDraftGuard(dirty || save.isPending, onDirty);
  const field = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => { setDraft((current) => ({ ...current, [key]: value })); save.reset(); };
  return <form class="fleet-process-form fleet-work-form" aria-label={original ? "Edit routine" : "New routine"} onSubmit={(event) => { event.preventDefault(); if (!save.isPending && connected) save.mutate(); }}>
    <h3>{original ? "Edit routine" : "New routine"}</h3>
    <p>Something for Ship to take care of regularly.</p>
    <fieldset disabled={save.isPending || !connected}>
      <label>Name<input autoFocus value={draft.name} onInput={(event) => field("name", event.currentTarget.value)} required /></label>
      <label>What should Ship do?<textarea rows={5} value={draft.message} onInput={(event) => field("message", event.currentTarget.value)} required /></label>
      <label>Repeat<select value={draft.cadence} onChange={(event) => field("cadence", event.currentTarget.value as typeof draft.cadence)}><option value="daily">Every day</option><option value="weekly">Every week</option><option value="every">At an interval</option><option value="cron">Custom schedule</option></select></label>
      {draft.cadence === "weekly" && <label>Day<select value={draft.day} onChange={(event) => field("day", event.currentTarget.value)}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, i) => <option key={day} value={String(i)}>{day}</option>)}</select></label>}
      {draft.cadence === "daily" || draft.cadence === "weekly" ? <label>Time<input type="time" required value={draft.time} onInput={(event) => field("time", event.currentTarget.value)} /></label> : draft.cadence === "every" ? <div class="fleet-work-interval"><label>Every<input type="number" min="0.001" step="any" required value={draft.interval} onInput={(event) => field("interval", event.currentTarget.value)} /></label><label>Unit<select value={draft.unit} onChange={(event) => field("unit", event.currentTarget.value)}><option value="1000">seconds</option><option value="60000">minutes</option><option value="3600000">hours</option><option value="86400000">days</option></select></label></div> : <label>Cron expression<input required value={draft.cron} onInput={(event) => field("cron", event.currentTarget.value)} placeholder="0 9 * * 1-5" /><small>minute · hour · day · month · weekday</small></label>}
      {original && draft.cadence !== "every" && draft.timezone !== timezone && <p class="dim">This routine uses {draft.timezone}.</p>}
      <label class="fleet-work-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => field("enabled", event.currentTarget.checked)} />Enabled</label>
    </fieldset>
    {save.error && <p class="error" role="alert">{save.error.message}</p>}
    <div class="fleet-work-actions"><button class="fleet-text-action" type="button" disabled={save.isPending} onClick={() => { if (!dirty || window.confirm("Discard this unsaved routine?")) onCancel(); }}>cancel</button><button class="ibtn is-primary" type="submit" disabled={!connected || save.isPending || (Boolean(original) && !dirty)}>{save.isPending ? <LoadingState>saving…</LoadingState> : original ? "save routine" : "create routine"}</button></div>
  </form>;
}
