import { QueryClient, QueryObserver } from "@tanstack/preact-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import { deferred } from "../../../testing/testHarness";
import { syncProcessSignal } from "./processSync";
import { INSTRUMENT_PROCESSES_KEY as KEY } from "./queryKeys";

const process = (pid = "p"): ConsoleProcess => ({
  pid, label: pid, state: "idle", rawState: "idle", uid: 2000, username: "agent", profile: "",
  cwd: "~", parentPid: null, interactive: false, personal: false, activeRunId: null,
  queuedCount: 0, createdAt: 1, lastActiveAt: 1,
});
const runtime = { state: "running" as const, activeRunId: "r", queuedCount: 0, lastActiveAt: 10 };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });

function setup(initial: ConsoleProcess[] | undefined, load: () => Promise<ConsoleProcess[]>) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cleanup.push(() => cache.clear());
  if (initial) cache.setQueryData(KEY, initial);
  const observer = new QueryObserver(cache, { queryKey: KEY, queryFn: load });
  const unsubscribe = observer.subscribe(() => undefined);
  cleanup.push(unsubscribe);
  return { cache, unsubscribe };
}

describe("process change notifications", () => {
  it("patches known processes and removes exits without fetching a list", async () => {
    const other = process("other");
    const load = vi.fn(async () => []);
    const { cache } = setup([process(), other], load);
    await syncProcessSignal(cache, "proc.changed", { pid: "p", changes: ["state"], runtime });
    expect(cache.getQueryData<ConsoleProcess[]>(KEY)?.[0]).toMatchObject({ state: "running", activeRunId: "r" });
    expect(cache.getQueryData<ConsoleProcess[]>(KEY)?.[1]).toBe(other);
    await syncProcessSignal(cache, "process.exit", { pid: "p" });
    expect(cache.getQueryData(KEY)).toEqual([other]);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads new records and changed labels but ignores history-only notices", async () => {
    const load = vi.fn(async () => [process(), { ...process("new"), label: "Renamed" }]);
    const { cache } = setup([process()], load);
    await syncProcessSignal(cache, "proc.changed", { pid: "new", changes: ["created"], runtime });
    await syncProcessSignal(cache, "proc.changed", { pid: "new", changes: ["title"] });
    await syncProcessSignal(cache, "proc.changed", { pid: "p", changes: ["messages"] });
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData<ConsoleProcess[]>(KEY)?.[1].label).toBe("Renamed");
  });

  it.each([{ initial: undefined }, { initial: [process()] }])("discards snapshots begun before an exit ($initial)", async ({ initial }) => {
    const older = deferred<ConsoleProcess[]>();
    const load = vi.fn().mockImplementationOnce(() => older.promise).mockResolvedValue([]);
    const { cache } = setup(initial, load);
    if (initial) void cache.refetchQueries({ queryKey: KEY });
    expect(load).toHaveBeenCalledOnce();
    await syncProcessSignal(cache, "process.exit", { pid: "p" });
    older.resolve([process()]);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData(KEY)).toEqual([]);
  });

  it("preserves signal order while cancelling a pending snapshot", async () => {
    const older = deferred<ConsoleProcess[]>();
    const latest = deferred<ConsoleProcess[]>();
    const load = vi.fn().mockImplementationOnce(() => older.promise).mockImplementation(() => latest.promise);
    const { cache } = setup([process()], load);
    void cache.refetchQueries({ queryKey: KEY });
    const first = syncProcessSignal(cache, "proc.changed", { pid: "p", runtime });
    const second = syncProcessSignal(cache, "proc.changed", { pid: "p", runtime: { ...runtime, state: "waiting_hil", lastActiveAt: 11 } });
    await Promise.resolve();
    expect(cache.getQueryData<ConsoleProcess[]>(KEY)?.[0].state).toBe("waiting_hil");
    latest.resolve([{ ...process(), state: "waiting_hil", rawState: "waiting_hil", activeRunId: "r" }]);
    await Promise.all([first, second]);
    older.resolve([process()]);
    await Promise.resolve();
    expect(cache.getQueryData<ConsoleProcess[]>(KEY)?.[0].state).toBe("waiting_hil");
  });

  it("invalidates a closed list without fetching until it reopens", async () => {
    const load = vi.fn(async () => [process("new")]);
    const { cache, unsubscribe } = setup([], load);
    unsubscribe();
    await syncProcessSignal(cache, "proc.changed", { pid: "new", changes: ["created"], runtime });
    expect(load).not.toHaveBeenCalled();
    expect(cache.getQueryState(KEY)?.isInvalidated).toBe(true);
    const observer = new QueryObserver(cache, { queryKey: KEY, queryFn: load });
    cleanup.push(observer.subscribe(() => undefined));
    await vi.waitFor(() => expect(cache.getQueryData(KEY)).toEqual([process("new")]));
    expect(load).toHaveBeenCalledOnce();
  });
});
