import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  ResponsibilityRecord,
  ResponsibilitySourceUpdateArgs,
  ResponsibilitySourcePolicy,
  ScheduleExpression,
  ScheduleRecord,
} from "@humansandmachines/gsv/protocol";

export type ResponsibilitiesClient = {
  r12y: Pick<GSVClient["r12y"], "list"> & {
    source: Pick<GSVClient["r12y"]["source"], "list" | "update">;
  };
  sched: Pick<GSVClient["sched"], "add" | "list" | "remove" | "update">;
};

export type ResponsibilitiesWorkspace = {
  open: ResponsibilityRecord[];
  history: ResponsibilityRecord[];
  sources: ResponsibilitySourcePolicy[];
  schedules: ScheduleRecord[];
};

export type ResponsibilityScheduleInput = {
  id?: string;
  name: string;
  instructions: string;
  expression: ScheduleExpression;
  enabled: boolean;
};

export type ResponsibilityWorkspaceMutation =
  | { kind: "source"; id: ResponsibilitySourceUpdateArgs["id"]; enabled: boolean }
  | { kind: "schedule.save"; input: ResponsibilityScheduleInput }
  | { kind: "schedule.toggle"; id: string; enabled: boolean }
  | { kind: "schedule.remove"; id: string };

export async function loadResponsibilitiesWorkspace(
  client: ResponsibilitiesClient,
): Promise<ResponsibilitiesWorkspace> {
  const [open, history, sources, schedules] = await Promise.all([
    client.r12y.list({
      states: ["open", "active", "waiting"],
      limit: 500,
    }),
    client.r12y.list({
      states: ["resolved", "cancelled"],
      includeTerminal: true,
      limit: 500,
    }),
    client.r12y.source.list({}),
    client.sched.list({ includeDisabled: true, limit: 500 }),
  ]);
  return {
    open: open.responsibilities,
    history: history.responsibilities,
    sources: sources.sources,
    schedules: schedules.schedules.filter((schedule) => (
      schedule.target.kind === "responsibility"
      && (schedule.expression.kind === "every" || schedule.expression.kind === "cron")
    )),
  };
}

export async function mutateResponsibilitiesWorkspace(
  client: ResponsibilitiesClient,
  mutation: ResponsibilityWorkspaceMutation,
): Promise<void> {
  if (mutation.kind === "source") {
    await client.r12y.source.update({
      id: mutation.id,
      enabled: mutation.enabled,
    });
    return;
  }
  if (mutation.kind === "schedule.toggle") {
    await client.sched.update({
      id: mutation.id,
      patch: { enabled: mutation.enabled },
    });
    return;
  }
  if (mutation.kind === "schedule.remove") {
    await client.sched.remove({ id: mutation.id });
    return;
  }
  const target = {
    kind: "responsibility" as const,
    message: mutation.input.instructions,
  };
  if (mutation.input.id) {
    await client.sched.update({
      id: mutation.input.id,
      patch: {
        name: mutation.input.name,
        enabled: mutation.input.enabled,
        expression: mutation.input.expression,
        target,
      },
    });
    return;
  }
  await client.sched.add({
    name: mutation.input.name,
    enabled: mutation.input.enabled,
    expression: mutation.input.expression,
    target,
  });
}
