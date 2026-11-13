import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestFrame } from "../protocol/frames";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ResponsibilityStore } from "./responsibility-store";
import { KernelConnection } from "./connection";
import { InitialOnboarding, INITIAL_ONBOARDING_DEDUPE_KEY } from "./onboarding-responsibility";

import * as utils from "../shared/utils";
import * as connect from "./connect";
import * as personalController from "./personal-controller";
const handleConnectMock = vi.spyOn(connect, "handleConnect");
const ensurePersonalControllerMock = vi.spyOn(personalController, "ensurePersonalController");
const getConversationByIdMock = vi.spyOn(utils, "getConversationById");

import { Kernel, kernelRuntimes } from "./do";

/** A Kernel prototype with its runtime modules attached and no Durable Object state. */
// SAFETY: tests assign the exact collaborators each scenario asserts on.
const bareKernel = (): any => {
  const kernel = Object.create(Kernel.prototype);
  Object.assign(kernel, kernelRuntimes(kernel));
  return kernel;
};

const PROCESS_IDENTITY = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

function connectFrame(): RequestFrame<"sys.connect"> {
  return {
    type: "req",
    id: "connect-1",
    call: "sys.connect",
    args: {
      protocol: 3,
      peer: {
        id: "web",
        platform: "web",
        version: "test",
      },
      auth: {
        username: "sam",
        password: "password",
      },
    },
  };
}

describe("Kernel personal controller connect lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensurePersonalControllerMock.mockResolvedValue("proc:personal");
    getConversationByIdMock.mockReturnValue({ initialize: vi.fn(async () => undefined) });
    handleConnectMock.mockResolvedValue({
      ok: true,
      peer: {
        id: "web",
        sessionId: "connection-1",
        principal: { kind: "human", account: PROCESS_IDENTITY },
        grant: { calls: [], signals: [], implements: [] },
      },
      result: {
        protocol: 3,
        server: {
          version: "test",
          release: "dev",
          connectionId: "connection-1",
        },
        peer: {
          id: "web",
          sessionId: "connection-1",
          principal: { kind: "human", account: PROCESS_IDENTITY },
          grant: { calls: [], signals: [], implements: [] },
        },
      },
    });
  });

  it("ensures a human controller before activating and accepting the connection", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = bareKernel();
    const ctx = {
      auth: {
        isPersonalAgentUid: vi.fn(() => false),
        getPasswdByUsername: vi.fn(() => PROCESS_IDENTITY),
        credentialEpoch: vi.fn(() => 0),
        isAccountDisabled: vi.fn(() => false),
      },
      conversations: {
        ensureShip: vi.fn(() => ({
          id: "conv:ship",
          ownerUid: 1000,
          kind: "ship",
        })),
      },
      config: { get: vi.fn(() => null) },
      env: {},
      // This owner has no welcome pending; starting one at sign-in is covered below.
      welcome: { activate: vi.fn(() => false) },
      reconcileResponsibilityWake: vi.fn(async () => {}),
      defer: vi.fn(),
    };
    const connection = { id: "connection-1", setState: vi.fn() };
    kernel.buildContext = vi.fn(() => ctx);
    kernel.connectionRuntime.activateConnection = vi.fn();
    kernel.connectionRuntime.broadcastTargetStatus = vi.fn();
    kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
    kernel.transport.sendOk = vi.fn();
    kernel.transport.sendError = vi.fn();

    await kernel.connectionRuntime.handleSysConnect(connection, connectFrame());

    expect(ensurePersonalControllerMock).toHaveBeenCalledWith(PROCESS_IDENTITY.uid, ctx);
    // The default profile publishes in the background, so sign-in doesn't wait on the open-network host.
    expect(ctx.defer).toHaveBeenCalledWith(expect.any(Promise));
    expect(ensurePersonalControllerMock.mock.invocationCallOrder[0])
      .toBeLessThan(kernel.connectionRuntime.activateConnection.mock.invocationCallOrder[0]);
    expect(kernel.connectionRuntime.activateConnection).toHaveBeenCalledOnce();
    expect(kernel.transport.sendOk).toHaveBeenCalledWith(
      connection,
      "connect-1",
      expect.objectContaining({ protocol: 3 }),
    );
  });

  it("does not activate a human connection when controller recovery fails", async () => {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = bareKernel();
    const ctx = {
      auth: {
        isPersonalAgentUid: vi.fn(() => false),
        getPasswdByUsername: vi.fn(() => PROCESS_IDENTITY),
        credentialEpoch: vi.fn(() => 0),
        isAccountDisabled: vi.fn(() => false),
      },
      conversations: { ensureShip: vi.fn() },
    };
    const connection = { id: "connection-1", setState: vi.fn() };
    kernel.buildContext = vi.fn(() => ctx);
    kernel.connectionRuntime.activateConnection = vi.fn();
    kernel.connectionRuntime.broadcastTargetStatus = vi.fn();
    kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
    kernel.transport.sendOk = vi.fn();
    kernel.transport.sendError = vi.fn();
    ensurePersonalControllerMock.mockRejectedValueOnce(new Error("controller unavailable"));

    await expect(kernel.connectionRuntime.handleSysConnect(connection, connectFrame()))
      .rejects.toThrow("controller unavailable");

    expect(kernel.connectionRuntime.activateConnection).not.toHaveBeenCalled();
    expect(kernel.transport.sendOk).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "human", uid: 1000, country: "CH", expected: 1 },
    { kind: "human", uid: 1000, country: undefined, expected: 0 },
    { kind: "human", uid: 1000, country: "CH", rejected: true, expected: 0 },
    { kind: "human", uid: 1000, country: "CH", revoked: true, expected: 0 },
    { kind: "human", uid: 0, country: "US", expected: 0 },
    { kind: "machine", uid: 1000, country: "US", expected: 0 },
    { kind: "service", uid: 1000, country: "US", expected: 0 },
    { kind: "human", uid: 1001, country: "US", agent: true, expected: 0 },
  ] as const)("reports country only after a successful owner sign-in: %j", async (scenario) => {
    const kernel = bareKernel();
    const account = { ...PROCESS_IDENTITY, uid: scenario.uid };
    const principal = { kind: scenario.kind, account };
    const peer = { id: "web", sessionId: "connection-1", principal, grant: { calls: [], signals: [], implements: [] } };
    handleConnectMock.mockResolvedValueOnce("rejected" in scenario
      ? { ok: false, code: 401, message: "Invalid credentials" }
      : { ok: true, peer, result: { protocol: 4, server: { version: "test", release: "dev", connectionId: "connection-1" }, peer } });
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      auth: {
        isPersonalAgentUid: () => "agent" in scenario,
        getPasswdByUsername: () => account,
        credentialEpoch: vi.fn().mockReturnValueOnce(0).mockReturnValue("revoked" in scenario ? 1 : 0),
        isAccountDisabled: () => false,
      },
      conversations: { ensureShip: () => ({ id: "conv:ship", ownerUid: 1000, kind: "ship" }) },
      config: { get: () => null, getExplicit: () => "1" },
      env: {},
      welcome: { activate: () => false },
      defer: (promise: Promise<unknown>) => deferred.push(promise),
    };
    kernel.installationId = "inst_country";
    kernel.bindings = { GSV_TELEMETRY_ENABLED: "1" };
    kernel.connections = new Map();
    kernel.buildContext = () => ctx;
    kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
    kernel.transport.sendOk = vi.fn();
    kernel.transport.sendError = vi.fn();
    const socket = { serializeAttachment: vi.fn() };
    // SAFETY: this path uses only the attachment writer on the WebSocket.
    const connection = new KernelConnection(socket as never, "connection-1", "https://gsv.test/ws", { step: "pending" as const, country: scenario.country });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await kernel.connectionRuntime.handleSysConnect(connection, connectFrame());
      await Promise.all(deferred);
      const records = log.mock.calls.map(([record]) => record).filter((record) => record?.event?.name === "ship.owner.connected");
      expect(records).toHaveLength(scenario.expected);
      if (scenario.expected) {
        expect(records[0]).toMatchObject({ component: "gateway", installationId: "inst_country", event: { stream: "product", properties: { country: "CH" } } });
        expect(records[0].event.properties).toEqual({ country: "CH" });
      }
      if (!("rejected" in scenario) && !("revoked" in scenario)) {
        expect(connection.state).not.toHaveProperty("country");
        expect(socket.serializeAttachment).toHaveBeenCalledWith(expect.objectContaining({ state: expect.not.objectContaining({ country: expect.anything() }) }));
      }
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    { handled: false, failWake: false },
    { handled: true, failWake: false },
    { handled: false, failWake: true },
    { handled: false, failWake: false, previousBrief: true },
  ])("starts pending onboarding when the owner signs in, without delaying sign-in: %j", async ({ handled, failWake, previousBrief }) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const onboarding = new InitialOnboarding(storage, responsibilities);
      onboarding.prepare(1000);
      if (handled || previousBrief) onboarding.activate(1000);
      const welcome = responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY);
      if (handled) responsibilities.update({ ownerUid: 1000, id: welcome!.id,
        patch: { state: "waiting", blocker: "Waiting for a reply", nextCheckAtMs: null },
        actor: { kind: "process", processId: "ship" }, observedByShip: true, now: Date.now() });
      if (previousBrief) responsibilities.update({ ownerUid: 1000, id: welcome!.id,
        patch: { state: "waiting", details: { responsibilityType: "onboarding.initial", instructions: "Previously saved onboarding instructions" },
          blocker: "Waiting for the user's first message." },
        actor: { kind: "system", component: "onboarding" }, observedByShip: true, now: Date.now() });
      const beforeConnect = responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY);
      const pending = !handled && !previousBrief;
      const deferred: Promise<unknown>[] = [];
      let finishWake = () => {};
      const wake = new Promise<void>((resolve, reject) => {
        finishWake = () => failWake ? reject(new Error("wake unavailable")) : resolve();
      });
      const kernel = bareKernel();
      const ctx = {
        auth: { isPersonalAgentUid: () => false, getPasswdByUsername: () => PROCESS_IDENTITY,
          credentialEpoch: () => 0, isAccountDisabled: () => false },
        conversations: { ensureShip: () => ({ id: "conv:ship", ownerUid: 1000, kind: "ship" }) },
        // The default profile was already applied; this test covers onboarding recovery only.
        config: { get: vi.fn(() => null), getExplicit: () => "1" },
        env: {},
        responsibilities, welcome: onboarding, reconcileResponsibilityWake: vi.fn(() => wake),
        defer: (promise: Promise<unknown>) => deferred.push(promise),
      };
      const connection = { id: "connection-1", setState: vi.fn() };
      kernel.buildContext = vi.fn(() => ctx);
      kernel.connectionRuntime.activateConnection = vi.fn();
      kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
      kernel.transport.sendOk = vi.fn();
      kernel.transport.sendError = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await kernel.connectionRuntime.handleSysConnect(connection, connectFrame());
        expect(kernel.transport.sendOk).toHaveBeenCalledOnce();
        expect(ctx.config.get).not.toHaveBeenCalledWith("users/1000/ui/welcome_card_seen");
        expect(responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)?.state)
          .toBe(pending ? "open" : handled || previousBrief ? "waiting" : undefined);
        expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledTimes(pending ? 1 : 0);
        if (previousBrief) expect(responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)).toEqual(beforeConnect);
        finishWake();
        await Promise.all(deferred);
        expect(warn).toHaveBeenCalledTimes(failWake ? 1 : 0);
        if (failWake) {
          const revision = responsibilities.revision(1000);
          ctx.reconcileResponsibilityWake.mockResolvedValueOnce();
          await kernel.connectionRuntime.handleSysConnect(connection, connectFrame());
          await Promise.all(deferred);
          expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledTimes(2);
          expect(responsibilities.revision(1000)).toBe(revision);
        }
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("records a first machine registration as Ship work before accepting it", async () => {
    const machine = {
      target_id: "workstation",
      owner_uid: 1000,
      label: "Workstation",
      description: "",
      implements: ["shell.exec"],
      platform: "linux",
      version: "test",
      online: true,
      first_seen_at: 1_700_000_000_000,
      last_seen_at: 1_700_000_000_000,
      connected_at: 1_700_000_000_000,
      disconnected_at: null,
    };
    const peer = {
      id: machine.target_id,
      sessionId: "connection-1",
      principal: { kind: "machine" as const, account: PROCESS_IDENTITY },
      grant: { calls: [], signals: ["target.status"], implements: ["shell.exec"] },
    };
    handleConnectMock.mockResolvedValueOnce({
      ok: true,
      peer,
      newMachine: machine,
      result: {
        protocol: 3,
        server: {
          version: "test",
          release: "dev",
          connectionId: "connection-1",
        },
        peer,
      },
    });

    const create = vi.fn(() => ({ created: true }));
    const ctx = {
      auth: {
        isPersonalAgentUid: vi.fn(() => false),
        getPasswdByUsername: vi.fn(() => PROCESS_IDENTITY),
        credentialEpoch: vi.fn(() => 0),
        isAccountDisabled: vi.fn(() => false),
      },
      responsibilitySources: { isEnabled: vi.fn(() => true) },
      noticeRules: { wantsNotice: vi.fn(() => false) },
      responsibilities: { create },
      reconcileResponsibilityWake: vi.fn(async () => undefined),
      defer: vi.fn((promise: Promise<unknown>) => {
        void promise;
      }),
    };
    const connection = { id: "connection-1", setState: vi.fn() };
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const kernel = bareKernel();
    kernel.buildContext = vi.fn(() => ctx);
    kernel.connectionRuntime.activateConnection = vi.fn();
    kernel.connectionRuntime.broadcastTargetStatus = vi.fn();
    kernel.connectionRuntime.reconcileOwnedIdentities = vi.fn();
    kernel.transport.sendOk = vi.fn();
    kernel.transport.sendError = vi.fn();

    await kernel.connectionRuntime.handleSysConnect(connection, connectFrame());

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: 1000,
      dedupeKey: expect.stringMatching(/^machine\.added:machine-added:[0-9a-f]{64}$/),
      source: expect.objectContaining({ eventType: "machine.added" }),
    }));
    expect(ctx.reconcileResponsibilityWake).toHaveBeenCalledWith(1000);
    expect(kernel.connectionRuntime.activateConnection).toHaveBeenCalledOnce();
    expect(kernel.transport.sendOk).toHaveBeenCalledOnce();
  });
});
