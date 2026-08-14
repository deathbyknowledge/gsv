import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleProcess, ConsoleResourceState } from "../domain/consoleModels";
import { createTestRoot } from "../messengers/messengerTestHarness";

const mocks = vi.hoisted(() => ({
  detailPids: [] as string[],
  listRenders: [] as Array<{ connectDisabled: boolean; ids: string[]; meta: string }>,
  processes: [] as ConsoleProcess[],
}));

function resource<T>(data: T): ConsoleResourceState<T> {
  return {
    data,
    isUnavailable: false,
    isLoading: false,
    isRefreshing: false,
    isError: false,
    errorText: "",
    isEmpty: false,
  };
}

vi.mock("../hooks/useConsoleData", () => ({
  useConsoleProcesses: () => ({
    data: mocks.processes,
    isFetching: false,
    isLoading: false,
    resource: resource(mocks.processes),
  }),
}));

vi.mock("../components/ConsolePageTemplate", () => ({
  ConsolePage: ({ children }: { children: ComponentChildren }) => children,
  ConsoleResourceBoundary: <T,>({
    render: renderResource,
    resource: resourceState,
  }: {
    render: (data: T) => ComponentChildren;
    resource: ConsoleResourceState<T>;
  }) => resourceState.data === null ? null : renderResource(resourceState.data),
}));

vi.mock("../list-template/ListTemplate", () => ({
  ListTemplate: (props: {
    connectDisabled?: boolean;
    listMeta: string;
    rows: Array<{ id: string }>;
  }) => {
    mocks.listRenders.push({
      connectDisabled: props.connectDisabled === true,
      ids: props.rows.map((row) => row.id),
      meta: props.listMeta,
    });
    return null;
  },
}));

vi.mock("./RuntimeDetailPage", () => ({
  RuntimeDetailPage: ({ process }: { process: ConsoleProcess }) => {
    mocks.detailPids.push(process.pid);
    return null;
  },
}));

import { RuntimePage } from "./RuntimePage";

function process(pid: string, personal: boolean, state: ConsoleProcess["state"] = "idle"): ConsoleProcess {
  return {
    pid,
    label: pid,
    state,
    rawState: state,
    uid: 1000,
    username: "aria",
    profile: "default",
    cwd: "/home/aria",
    parentPid: null,
    interactive: true,
    personal,
    activeRunId: state === "running" ? `run:${pid}` : null,
    queuedCount: 0,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

let root: ReturnType<typeof createTestRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("document", {});
  mocks.detailPids = [];
  mocks.listRenders = [];
  mocks.processes = [];
  root = createTestRoot("The Runtime page harness");
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("Runtime Work list", () => {
  it("omits the canonical personal process from rows and active counts", async () => {
    mocks.processes = [
      process("personal", true, "running"),
      process("work", false),
    ];

    await root?.render(<RuntimePage />);

    expect(mocks.listRenders.at(-1)).toEqual({
      connectDisabled: true,
      ids: ["work"],
      meta: "0/1 ACTIVE",
    });
  });

  it("enables new work only when the shell supplies an authorized action", async () => {
    await root?.render(<RuntimePage onNewTask={vi.fn()} />);

    expect(mocks.listRenders.at(-1)?.connectDisabled).toBe(false);
  });

  it("clears a directly addressed canonical detail without rendering Work actions", async () => {
    const onSelectionChange = vi.fn();
    mocks.processes = [process("personal", true, "running")];

    await root?.render(
      <RuntimePage initialDetailId="personal" onSelectionChange={onSelectionChange} />,
    );

    expect(mocks.detailPids).toEqual([]);
    expect(mocks.listRenders.at(-1)?.ids).toEqual([]);
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it("still opens an explicitly addressed Work detail", async () => {
    const onSelectionChange = vi.fn();
    mocks.processes = [process("work", false)];

    await root?.render(
      <RuntimePage initialDetailId="work" onSelectionChange={onSelectionChange} />,
    );

    expect(mocks.detailPids).toContain("work");
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("does not retain a prior owner's Work detail or actions when process data changes", async () => {
    mocks.processes = [process("alice-work", false)];
    await root?.render(<RuntimePage initialDetailId="alice-work" />);
    expect(mocks.detailPids).toContain("alice-work");

    mocks.detailPids = [];
    mocks.processes = [];
    await root?.render(<RuntimePage initialDetailId="alice-work" />);

    expect(mocks.detailPids).toEqual([]);
    expect(mocks.listRenders.at(-1)?.ids).toEqual([]);
  });
});
