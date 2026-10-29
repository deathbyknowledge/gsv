import { describe, expect, it } from "vitest";
import { testPeer } from "../test-support/peers";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { NoticeRuleStore, handleNotifyRuleList, handleNotifyRuleReset, handleNotifyRuleSet } from "./notice-rules";

const OWNER = 1000;
const SHIP_PID = "proc:ship";

function context(noticeRules: NoticeRuleStore, caller: "client" | "ship" | "worker" = "client"): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
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
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as unknown as KernelContext;
}

describe("notice rules", () => {
  it("lists every kind at its default until its owner changes one", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const rules = new NoticeRuleStore(storage);
      expect(handleNotifyRuleList({}, context(rules)).rules).toEqual([
        { kind: "contact.request", notify: "messenger", defaultNotify: "messenger" },
        { kind: "contact.message", notify: "messenger", defaultNotify: "messenger" },
        { kind: "contact.invite.accepted", notify: "messenger", defaultNotify: "messenger" },
      ]);
    });
  });

  it("records whether the person or their Ship changed a rule, and resets it to its default", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const rules = new NoticeRuleStore(storage);
      expect(handleNotifyRuleSet({ kind: "contact.message", notify: "none" }, context(rules)).rule).toMatchObject({
        kind: "contact.message", notify: "none", defaultNotify: "messenger", changedBy: "person",
      });
      expect(rules.notifies(OWNER, "contact.message")).toBe("none");
      expect(handleNotifyRuleSet({ kind: "contact.message", notify: "messenger" }, context(rules, "ship")).rule)
        .toMatchObject({ notify: "messenger", changedBy: "ship" });

      expect(handleNotifyRuleReset({ kind: "contact.message" }, context(rules)).rule).toEqual({
        kind: "contact.message", notify: "messenger", defaultNotify: "messenger",
      });
      expect(rules.notifies(1001, "contact.message")).toBe("messenger");
    });
  });

  it("refuses an unknown kind or delivery, and a process that is not the owner's Ship", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const rules = new NoticeRuleStore(storage);
      expect(() => handleNotifyRuleSet({ kind: "mail.received", notify: "none" }, context(rules)))
        .toThrow(/^notify\.rule\.set: /);
      expect(() => handleNotifyRuleSet({ kind: "contact.message", notify: "everywhere" }, context(rules)))
        .toThrow(/^notify\.rule\.set: /);
      expect(() => handleNotifyRuleSet({ kind: "contact.message", notify: "none" }, context(rules, "worker")))
        .toThrow("signed-in human or their Ship");
      expect(rules.notifies(OWNER, "contact.message")).toBe("messenger");
    });
  });
});
