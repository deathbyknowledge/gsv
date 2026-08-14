import { describe, expect, it, vi } from "vitest";
import type { SessionPhase, SessionSnapshot } from "../services/session/sessionService";
import {
  resolveScopedWebQueryClient,
  webQuerySessionScope,
} from "./AppProviders";

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
});
