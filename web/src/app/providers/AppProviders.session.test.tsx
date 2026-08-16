import { act } from "preact/test-utils";
import { useEffect } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../features/gsv-console/messengers/messengerTestHarness";
import type {
  SessionService,
  SessionSnapshot,
} from "../services/session/sessionService";

const sessionFactory = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../services/session/sessionService", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../services/session/sessionService")
  >();
  return {
    ...original,
    createSessionService: sessionFactory.create,
  };
});

vi.mock("../services/query/GatewaySignalInvalidator", () => ({
  GatewaySignalInvalidator: () => null,
}));

import { AppProviders } from "./AppProviders";

function session(phase: SessionSnapshot["phase"]): SessionSnapshot {
  return {
    phase,
    url: "wss://example.test/ws",
    username: "hank",
    connectionId: phase === "ready" ? "connection:hank" : null,
    server: null,
    message: null,
    setupResult: null,
  };
}

function createSessionHarness() {
  let current = session("locked");
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();
  const start = vi.fn(async () => {});
  const service: SessionService = {
    client: {} as SessionService["client"],
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
    login: async () => {
      throw new Error("Not used by this test");
    },
    setup: async () => {
      throw new Error("Not used by this test");
    },
    continueFromSetup: async () => {
      throw new Error("Not used by this test");
    },
    lock: () => {},
    start,
  };

  return {
    service,
    start,
    emit: (next: SessionSnapshot) => {
      current = next;
      for (const listener of listeners) {
        listener(current);
      }
    },
  };
}

function MountProbe({ lifecycle }: { lifecycle: string[] }) {
  useEffect(() => {
    lifecycle.push("mount");
    return () => {
      lifecycle.push("unmount");
    };
  }, []);
  return null;
}

describe("session bootstrap ownership", () => {
  it("starts once when the signed-out query tree remounts after login", async () => {
    const root = createTestRoot("The session bootstrap provider harness");
    const harness = createSessionHarness();
    const lifecycle: string[] = [];
    sessionFactory.create.mockReturnValue(harness.service);
    vi.stubGlobal("document", {});

    try {
      await root.render(
        <AppProviders>
          <MountProbe lifecycle={lifecycle} />
        </AppProviders>,
      );
      await vi.waitFor(() => {
        expect(harness.start).toHaveBeenCalledOnce();
      });
      expect(lifecycle).toEqual(["mount"]);

      await act(async () => {
        harness.emit(session("ready"));
      });

      expect(harness.start).toHaveBeenCalledOnce();
      expect(lifecycle).toEqual(["mount", "unmount", "mount"]);
    } finally {
      await root.unmount();
      vi.unstubAllGlobals();
      sessionFactory.create.mockReset();
    }
  });
});
