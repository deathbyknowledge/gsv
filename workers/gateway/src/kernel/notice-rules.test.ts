import { describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { NoticeRuleStore, handleNotifyRuleList, handleNotifyRuleReset, handleNotifyRuleSet } from "./notice-rules";
import { OwnerNoticeStore } from "./owner-notice-store";
import { ResponsibilitySourcePolicyStore } from "./responsibility-source-policies";

const OWNER = 1000;
const SHIP_PID = "proc:ship";

function stores(storage: DurableObjectStorage) {
  const sources = new ResponsibilitySourcePolicyStore(storage.sql);
  return { sources, rules: new NoticeRuleStore(storage, sources), notices: new OwnerNoticeStore(storage) };
}

function context(noticeRules: NoticeRuleStore, ownerNotices: OwnerNoticeStore, caller: "client" | "ship" | "worker" = "client"): KernelContext {
  const ctx = {
    peer: testPeer({ kind: "human", account: {
      uid: OWNER, gid: OWNER, gids: [OWNER], username: "ada", home: "/home/ada", cwd: "/home/ada",
    }, calls: ["notify.rule.*"] }),
    ...(caller === "client" ? { connection: { id: "connection-1", state: {} } } : { processId: SHIP_PID }),
    procs: {
      get: (pid: string) => pid === SHIP_PID
        ? { processId: SHIP_PID, ownerUid: OWNER, isPersonalController: caller === "ship" }
        : null,
      getOwnerUid: (pid: string) => pid === SHIP_PID ? OWNER : null,
    },
    auth: {
      getPasswdByUid: (uid: number) => uid === OWNER ? { uid, username: "ada" } : null,
      getShadowByUsername: () => ({ password: "hash" }),
      isPersonalAgentUid: () => false,
    },
    noticeRules,
    ownerNotices,
    queueOwnerNotices: vi.fn(async () => undefined),
    defer: vi.fn(),
  };
  // SAFETY: the fixture provides the Kernel context fields the rule handlers use.
  return ctx as KernelContext;
}

describe("notice rules", () => {
  it("lists every kind at what happens today until its owner changes one", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { rules, notices } = stores(storage);
      const contact = { notify: "messenger", ship: "context", defaultNotify: "messenger", defaultShip: "context", shipChoices: ["none", "context"] };
      const source = { notify: "none", ship: "wake", defaultNotify: "none", defaultShip: "wake", shipChoices: ["none", "context", "wake"] };
      expect(handleNotifyRuleList(context(rules, notices)).rules).toEqual([
        { kind: "contact.request", ...contact },
        { kind: "contact.message", ...contact },
        { kind: "contact.invite.accepted", ...contact },
        { kind: "mail.received", ...source },
        { kind: "machine.added", ...source },
        { kind: "adapter.connected", ...source },
        { kind: "adapter.auth_required", ...source },
      ]);
    });
  });

  it("records whether the person or their Ship changed a rule, and resets it to its default", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { rules, notices } = stores(storage);
      expect(handleNotifyRuleSet({ kind: "contact.message", notify: "none" }, context(rules, notices)).rule).toMatchObject({
        kind: "contact.message", notify: "none", ship: "context", changedBy: "person",
      });
      expect(rules.notifies(OWNER, "contact.message")).toBe("none");
      expect(handleNotifyRuleSet({ kind: "contact.message", notify: "messenger" }, context(rules, notices, "ship")).rule)
        .toMatchObject({ notify: "messenger", changedBy: "ship" });

      expect(handleNotifyRuleReset({ kind: "contact.message" }, context(rules, notices)).rule).toMatchObject({
        kind: "contact.message", notify: "messenger", ship: "context",
      });
      expect(rules.notifies(1001, "contact.message")).toBe("messenger");
    });
  });

  it("changes one choice without touching the other, and keeps waking on the kind's source", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { rules, notices, sources } = stores(storage);
      const ctx = context(rules, notices);
      expect(handleNotifyRuleSet({ kind: "mail.received", notify: "messenger" }, ctx).rule).toMatchObject({ notify: "messenger", ship: "wake" });
      expect(sources.isEnabled(OWNER, "mail.received")).toBe(true);

      expect(handleNotifyRuleSet({ kind: "mail.received", ship: "context" }, ctx).rule).toMatchObject({ notify: "messenger", ship: "context" });
      expect(sources.isEnabled(OWNER, "mail.received")).toBe(false);
      expect(rules.wantsNotice(OWNER, "mail.received")).toBe(true);

      handleNotifyRuleSet({ kind: "mail.received", notify: "none", ship: "none" }, ctx);
      expect(rules.wantsNotice(OWNER, "mail.received")).toBe(false);

      // A source disabled before rules existed, or from the shell, reads the same way.
      sources.set(OWNER, "machine.added", false);
      expect(rules.ship(OWNER, "machine.added")).toBe("none");

      expect(handleNotifyRuleReset({ kind: "mail.received" }, ctx).rule).toMatchObject({ notify: "none", ship: "wake" });
      expect(sources.isEnabled(OWNER, "mail.received")).toBe(true);
    });
  });

  it("never lets a rule start a run on a contact's words", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { rules, notices } = stores(storage);
      for (const kind of ["contact.message", "contact.request", "contact.invite.accepted"] as const) {
        expect(() => handleNotifyRuleSet({ kind, ship: "wake" }, context(rules, notices))).toThrow("Ship can't wake");
        expect(rules.ship(OWNER, kind)).toBe("context");
      }
    });
  });

  it("tells the person when Ship stops telling them or starts acting, and not otherwise", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { rules, notices } = stores(storage);
      handleNotifyRuleSet({ kind: "machine.added", ship: "none" }, context(rules, notices, "ship"));
      expect(notices.next(OWNER)).toBeNull();

      handleNotifyRuleSet({ kind: "machine.added", ship: "wake" }, context(rules, notices, "ship"));
      expect(notices.next(OWNER)).toMatchObject({ topic: "notice.rule.changed", subject: { from: "machine.added", ruleChange: "started-acting" } });

      const quiet = stores(storage);
      handleNotifyRuleSet({ kind: "contact.request", notify: "none" }, context(quiet.rules, quiet.notices));
      expect(notices.next(OWNER)?.subject.from).toBe("machine.added");
      handleNotifyRuleSet({ kind: "contact.message", notify: "none" }, context(rules, notices, "ship"));
      const kinds = storage.sql.exec<{ subject_json: string }>("SELECT subject_json FROM owner_notices WHERE topic = 'notice.rule.changed'").toArray();
      expect(kinds.map(({ subject_json }) => JSON.parse(subject_json).ruleChange).sort()).toEqual(["started-acting", "stopped-telling"]);
    });
  });

  it("tells the person when a reset by Ship starts it acting or stops telling them, but not for the person's own reset", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { rules, notices } = stores(storage);
      const changes = () => storage.sql.exec<{ subject_json: string }>("SELECT subject_json FROM owner_notices WHERE topic = 'notice.rule.changed'")
        .toArray().map(({ subject_json }) => JSON.parse(subject_json));
      handleNotifyRuleSet({ kind: "mail.received", notify: "messenger", ship: "none" }, context(rules, notices));
      handleNotifyRuleReset({ kind: "mail.received" }, context(rules, notices));
      expect(changes()).toEqual([]);

      handleNotifyRuleSet({ kind: "mail.received", notify: "messenger", ship: "none" }, context(rules, notices));
      handleNotifyRuleReset({ kind: "mail.received" }, context(rules, notices, "ship"));
      expect(changes().map(({ from, ruleChange }) => [from, ruleChange]).sort()).toEqual([
        ["mail.received", "started-acting"],
        ["mail.received", "stopped-telling"],
      ]);
    });
  });

  it("signals its owner's clients on every set and reset, whoever made it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const changed = vi.fn();
      const sources = new ResponsibilitySourcePolicyStore(storage.sql);
      const rules = new NoticeRuleStore(storage, sources, changed);
      const notices = new OwnerNoticeStore(storage);
      handleNotifyRuleSet({ kind: "contact.message", notify: "none" }, context(rules, notices, "ship"));
      expect(changed).toHaveBeenCalledTimes(1);
      handleNotifyRuleReset({ kind: "contact.message" }, context(rules, notices));
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledWith(OWNER);
    });
  });

  it("refuses an unknown kind or delivery, an empty change, and a process that is not the owner's Ship", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { rules, notices } = stores(storage);
      expect(() => handleNotifyRuleSet(JSON.parse('{"kind":"memory.review","notify":"none"}'), context(rules, notices)))
        .toThrow(/^notify\.rule\.set: /);
      expect(() => handleNotifyRuleSet(JSON.parse('{"kind":"contact.message","notify":"everywhere"}'), context(rules, notices)))
        .toThrow(/^notify\.rule\.set: /);
      expect(() => handleNotifyRuleSet({ kind: "contact.message" }, context(rules, notices))).toThrow("choose notify or ship");
      expect(() => handleNotifyRuleSet({ kind: "contact.message", notify: "none" }, context(rules, notices, "worker")))
        .toThrow("signed-in human or their Ship");
      expect(rules.notifies(OWNER, "contact.message")).toBe("messenger");
    });
  });
});
