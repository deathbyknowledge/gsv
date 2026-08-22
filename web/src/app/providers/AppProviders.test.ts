import { useQuery } from "@tanstack/preact-query";
import { createElement } from "preact";
import { act } from "preact/test-utils";
import { useEffect } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import {
  createTestRoot,
  deferred,
} from "../features/gsv-console/messengers/messengerTestHarness";
import type { SessionPhase, SessionSnapshot } from "../services/session/sessionService";

import {
  resolveScopedWebQueryClient,
  SessionScopedQueryProvider,
  webQuerySessionScope,
} from "./AppProviders";

type PrivateQueryData = {
  owner: string;
};

type QueryProbeProps = {
  lifecycle: string[];
  load: () => Promise<PrivateQueryData>;
  observations: string[];
  owner: string;
  setRefetch: (refetch: () => Promise<QueryRefetchResult>) => void;
};
type QueryRefetchResult = Awaited<ReturnType<ReturnType<typeof useQuery<PrivateQueryData>>["refetch"]>>;
type QueryControl = { refetch?: () => Promise<QueryRefetchResult> };

const PRIVATE_QUERY_KEY = ["processes", "gsv-console"] as const;
const NoopInvalidator = () => null;

function QueryProbe({
  lifecycle,
  load,
  observations,
  owner,
  setRefetch,
}: QueryProbeProps) {
  const query = useQuery({
    queryKey: PRIVATE_QUERY_KEY,
    queryFn: load,
    staleTime: Infinity,
  });
  setRefetch(query.refetch);

  useEffect(() => {
    lifecycle.push(`mount:${owner}`);
    return () => {
      lifecycle.push(`unmount:${owner}`);
    };
  }, []);

  useEffect(() => {
    if (query.data) {
      observations.push(query.data.owner);
    }
  }, [observations, query.data]);

  return null;
}

function session(phase: SessionPhase, username: string): SessionSnapshot {
  return {
    phase,
    url: "wss://example.test/ws",
    username,
    connectionId: phase === "ready" ? `connection:${username}` : null,
    server: null,
    message: null,
    setupResult: null,
  };
}

describe("authenticated query isolation", () => {
  it("does not reuse fresh private Work data across Alice lock and Bob login", async () => {
    const queryKey = ["processes", "gsv-console"] as const;
    const alice = resolveScopedWebQueryClient(
      null,
      webQuerySessionScope(session("ready", "alice")),
    );
    alice.client.setQueryData(queryKey, {
      owner: "alice",
      detailPid: "alice-work",
      actions: ["reset", "kill"],
    });

    const staleQuery = vi.fn(async () => ({ owner: "unexpected" }));
    expect(await alice.client.fetchQuery({ queryKey, queryFn: staleQuery })).toMatchObject({
      owner: "alice",
      detailPid: "alice-work",
    });
    expect(staleQuery).not.toHaveBeenCalled();

    const locked = resolveScopedWebQueryClient(
      alice,
      webQuerySessionScope(session("locked", "alice")),
    );
    const bob = resolveScopedWebQueryClient(
      locked,
      webQuerySessionScope(session("ready", "bob")),
    );

    expect(locked.client).not.toBe(alice.client);
    expect(bob.client).not.toBe(alice.client);
    expect(bob.client.getQueryData(queryKey)).toBeUndefined();

    const loadBob = vi.fn(async () => ({
      owner: "bob",
      detailPid: null,
      actions: [],
    }));
    await expect(bob.client.fetchQuery({ queryKey, queryFn: loadBob })).resolves.toEqual({
      owner: "bob",
      detailPid: null,
      actions: [],
    });
    expect(loadBob).toHaveBeenCalledOnce();
  });

  it("keeps one client during a same-owner ready connection", () => {
    const scope = webQuerySessionScope(session("ready", "alice"));
    const first = resolveScopedWebQueryClient(null, scope);
    const second = resolveScopedWebQueryClient(first, scope);

    expect(second).toBe(first);
  });

  it("remounts query hooks across Alice lock and Bob login", async () => {
    vi.stubGlobal("document", {});
    const root = createTestRoot("The authenticated query provider harness");
    const lifecycle: string[] = [];
    const observations: string[] = [];
    const lateAlice = deferred<PrivateQueryData>();
    const locked = deferred<PrivateQueryData>();
    const loadAlice = vi.fn<() => Promise<PrivateQueryData>>()
      .mockResolvedValueOnce({ owner: "alice" })
      .mockReturnValueOnce(lateAlice.promise);
    const loadLocked = vi.fn(() => locked.promise);
    const loadBob = vi.fn(async () => ({ owner: "bob" }));
    const queryControl: QueryControl = {};
    const setRefetch = (next: () => Promise<QueryRefetchResult>) => {
      queryControl.refetch = next;
    };
    const renderScope = async (
      scope: string,
      owner: string,
      load: () => Promise<PrivateQueryData>,
    ) => {
      await root.render(createElement(
        SessionScopedQueryProvider,
        {
          scope,
          QueryInvalidator: NoopInvalidator,
          children: createElement(QueryProbe, {
            lifecycle,
            load,
            observations,
            owner,
            setRefetch,
          }),
        },
      ));
    };

    try {
      await renderScope("user:alice", "alice", loadAlice);
      await vi.waitFor(() => {
        expect(observations).toEqual(["alice"]);
      });

      const pendingAlice = queryControl.refetch?.();
      expect(pendingAlice).toBeDefined();
      await vi.waitFor(() => {
        expect(loadAlice).toHaveBeenCalledTimes(2);
      });

      await renderScope("signed-out", "locked", loadLocked);
      await renderScope("user:bob", "bob", loadBob);
      await vi.waitFor(() => {
        expect(observations).toEqual(["alice", "bob"]);
      });

      expect(loadBob).toHaveBeenCalledOnce();
      expect(lifecycle).toEqual([
        "mount:alice",
        "unmount:alice",
        "mount:locked",
        "unmount:locked",
        "mount:bob",
      ]);

      await act(async () => {
        lateAlice.resolve({ owner: "alice-late" });
        await pendingAlice;
      });

      expect(observations).toEqual(["alice", "bob"]);
    } finally {
      await root.unmount();
      vi.unstubAllGlobals();
    }
  });
});
