import { describe, expect, it } from "vitest";
import { makeShadowEntry } from "../../auth/shadow";
import { runSqlMigrations } from "../../schema/runner";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { accountHomeRepoRef } from "../../fs/ripgit/repos";
import { AuthStore } from "../auth-store";
import { canOwnerDelegateRunAs } from "../account-access";
import { isUsernameAvailable } from "../accounts";
import { accountIdentity } from "../accounts";
import { ProcessRegistry } from "../processes";
import { ScheduleStore } from "../scheduler";
import { createCronFileService } from "../crontab";
import type { KernelContext } from "../context";
import { testPeer } from "../../test-support/peers";
import { env } from "cloudflare:workers";
import { createAccountHomeBackend } from "../../fs/backends/account-home";
import { GsvFs } from "../../fs/gsv-fs";
import { canReadRepo, canWriteRepo, handleRepoApply, handleRepoRead } from "../repo";
import { KERNEL_MIGRATIONS, KERNEL_SCHEMA_COMPONENT, runKernelSqlMigrations } from "./migrations";

function seed(sql: SqlStorage, storage: DurableObjectStorage, username = "algo") {
  runSqlMigrations(storage, KERNEL_SCHEMA_COMPONENT, KERNEL_MIGRATIONS.filter((migration) => migration.id < 53));
  const auth = new AuthStore(sql);
  auth.addUser({ uid: 1000, gid: 1000, username: "person", home: "/home/person", gecos: "", shell: "/bin/init" });
  auth.addUser({ uid: 1001, gid: 1001, username, home: `/home/${username}`, gecos: username === "algo" ? "Algo" : "Custom", shell: "/bin/init" });
  auth.addGroup({ name: "person", gid: 1000, members: [username] });
  auth.addGroup({ name: username, gid: 1001, members: ["person", username] });
  auth.addGroup({ name: "users", gid: 100, members: ["person", username, "algorithm"] });
  auth.setShadow(makeShadowEntry(username, "!"));
  auth.setPersonalAgent(1000, 1001);
  sql.exec("INSERT INTO group_capabilities (gid, capability) VALUES (1001, 'fs.*')");
  sql.exec("INSERT INTO config_kv (key, value) VALUES ('users/1001/ai/reasoning', 'high')");
  sql.exec(`INSERT INTO processes (process_id, uid, owner_uid, gid, gids, username, home, cwd, created_at)
    VALUES ('proc:existing', 1001, 1000, 1001, '[1001,1000,100]', ?, ?, ?, 1)`, username, `/home/${username}`, `/home/${username}/work`);
  return auth;
}

describe("personal agent rename", () => {
  it("upgrades once while retaining ownership, credentials, homes, config and processes", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage);
      const token = await auth.issueToken({ uid: 1001, kind: "human" });
      const shadow = auth.getShadowByUsername("algo")!;
      const credentials = sql.exec("SELECT * FROM auth_tokens").toArray();
      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      const ship = auth.getPasswdByUid(1001)!;
      expect(ship).toMatchObject({ username: "ship", repoOwner: "algo", uid: 1001, gid: 1001, gecos: "Ship", home: "/home/algo" });
      expect(auth.getPasswdByUsername("algo")).toBeNull();
      expect(auth.getPasswdByHome("/home/algo")).toEqual(ship);
      expect(accountHomeRepoRef(ship)).toEqual({ owner: "algo", repo: "home" });
      expect(auth.getShadowByUsername("ship")).toEqual({ ...shadow, username: "ship" });
      expect(sql.exec("SELECT * FROM auth_tokens").toArray()).toEqual(credentials);
      expect(await auth.authenticateToken("ship", token.token)).toMatchObject({ ok: true, identity: { uid: 1001, repoOwner: "algo" } });
      expect(auth.getPasswdByRepoOwner("algo")).toEqual(ship);
      const processes = new ProcessRegistry(sql);
      expect(processes.getIdentity("proc:existing")).toMatchObject({ username: "ship", repoOwner: "algo" });
      processes.spawn("proc:child", accountIdentity(auth, ship), {});
      expect(processes.getIdentity("proc:child")).toMatchObject({ username: "ship", repoOwner: "algo" });
      expect(auth.getPersonalAgentUid(1000)).toBe(1001);
      expect(auth.resolveGids("ship", 1001).sort()).toEqual([100, 1000, 1001]);
      expect(auth.getGroupByName("users")?.members).toEqual(["person", "ship", "algorithm"]);
      expect(canOwnerDelegateRunAs(auth, 1000, ship)).toBe(true);
      expect(isUsernameAvailable(auth, "algo")).toBe(false);
      expect(sql.exec("SELECT * FROM group_capabilities").toArray()).toEqual([{ gid: 1001, capability: "fs.*" }]);
      expect(sql.exec("SELECT * FROM config_kv").toArray()).toEqual([{ key: "users/1001/ai/reasoning", value: "high" }]);
      expect(sql.exec("SELECT process_id, username, home, cwd FROM processes WHERE process_id = 'proc:existing'").one()).toEqual({ process_id: "proc:existing", username: "ship", home: "/home/algo", cwd: "/home/algo/work" });

      const reads: string[] = [];
      const ripgit = { fetch: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        reads.push(url.pathname);
        if (url.pathname === "/hyperspace/repos/algo/home/read" && url.searchParams.get("path") === "context.d/notes.md") {
          return new Response("Preserved owner instructions");
        }
        return new Response(null, { status: 404 });
      } } satisfies Fetcher;
      const person = accountIdentity(auth, auth.getPasswdByUid(1000)!);
      const backend = createAccountHomeBackend(env.STORAGE, ripgit, person, { auth, ownerUid: 1000, isRoot: false });
      const fs = new GsvFs(env.STORAGE, person, undefined, undefined, null, backend);
      expect(await fs.readdir("/home")).toEqual(["algo", "person"]);
      expect(await fs.readFile("/home/algo/context.d/notes.md")).toBe("Preserved owner instructions");
      expect(reads).toContain("/hyperspace/repos/algo/home/read");
    });
  });

  it.each(["/home/custom", "/home/ship"])("retains customized home %s and reserves the original repository namespace through passwd rewrites", async (home) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage);
      auth.updateUser("algo", { home, gecos: "My assistant" });
      runKernelSqlMigrations(storage);
      const ship = auth.getPasswdByUid(1001)!;
      expect(ship).toMatchObject({ username: "ship", repoOwner: "algo", home, gecos: "My assistant" });
      expect(accountHomeRepoRef(ship)).toEqual({ owner: "algo", repo: "home" });
      auth.importPasswd(auth.serializePasswd());
      expect(auth.getPasswdByUid(1001)).toEqual(ship);
      expect(isUsernameAvailable(auth, "algo")).toBe(false);
    });
  });

  it("does not infer repository ownership from a pre-existing account's home", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage, "ship");
      auth.updateUser("ship", { home: "/home/algo" });
      runKernelSqlMigrations(storage);
      expect(accountHomeRepoRef(auth.getPasswdByUid(1001)!)).toEqual({ owner: "ship", repo: "home" });
    });
  });

  it.each([
    { username: "algo", home: "/home/other", shipHome: "/home/algo" },
    { username: "other", home: "/home/algo", shipHome: "/home/algo" },
    { username: "other", home: "/home/ship", shipHome: "/home/ship" },
  ])("rejects passwd imports that reuse Ship's repository or home: $username at $home", async ({ username, home, shipHome }) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage);
      runKernelSqlMigrations(storage);
      const before = auth.getPasswdEntries();
      const imported = auth.serializePasswd().replace(":/home/algo:", `:${shipHome}:`)
        + `${username}:x:1002:1002:Other:${home}:/bin/init\n`;
      expect(() => auth.importPasswd(imported)).toThrow("Home or repository namespace already belongs to account: ship");
      expect(auth.getPasswdEntries()).toEqual(before);
      expect(auth.getPasswdByUsername(username)).toBeNull();
    });
  });

  it("allows distinct accounts in passwd imports without losing Ship's repository ownership", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage);
      runKernelSqlMigrations(storage);
      auth.importPasswd(auth.serializePasswd() + "other:x:1002:1002:Other:/home/other:/bin/init\n");
      expect(accountHomeRepoRef(auth.getPasswdByUid(1001)!)).toEqual({ owner: "algo", repo: "home" });
      expect(accountHomeRepoRef(auth.getPasswdByUid(1002)!)).toEqual({ owner: "other", repo: "home" });
    });
  });

  it.each([
    { actorUid: 1001, ownerUid: 1000 },
    { actorUid: 1000, ownerUid: 1000 },
    { actorUid: 1002, ownerUid: 1001 },
  ])("keeps repository grants on the retained namespace for actor $actorUid owned by $ownerUid", async ({ actorUid, ownerUid }) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage);
      runKernelSqlMigrations(storage);
      auth.addUser({ username: "helper", uid: 1002, gid: 1002, home: "/home/helper", gecos: "Helper", shell: "/bin/init" });
      auth.addGroup({ name: "helper", gid: 1002, members: ["ship"] });
      // SAFETY: these authorization checks need only the caller, auth, and private-by-default visibility; denied syscalls must never reach Ripgit.
      const ctx = { auth, callerOwnerUid: ownerUid, config: { get: () => null }, peer: testPeer({
        account: accountIdentity(auth, auth.getPasswdByUid(actorUid)!), calls: ["repo.read", "repo.apply"],
      }) } as KernelContext;
      expect(canWriteRepo("algo/private", ctx)).toBe(true);
      expect(canReadRepo("algo/private", ctx)).toBe(true);
      expect(canWriteRepo("ship/private", ctx)).toBe(false);
      expect(canReadRepo("ship/private", ctx)).toBe(false);
      await expect(handleRepoRead({ repo: "ship/private", path: "README.md" }, ctx)).rejects.toThrow("Forbidden");
      await expect(handleRepoApply({ repo: "ship/private", message: "Must not write", ops: [] }, ctx)).rejects.toThrow("Forbidden");
    });
  });

  it("keeps scheduled run-as identities and crontab management attached to the renamed account", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage);
      const schedules = new ScheduleStore(sql);
      const principal = { kind: "process" as const, uid: 1001, username: "algo", pid: "proc:existing" };
      const base = { ownerUid: 1000, creator: principal, runAs: principal, name: "Scheduled work", enabled: true,
        expression: { kind: "every" as const, everyMs: 60_000 }, now: 1 };
      const inherited = schedules.create({ ...base, target: { kind: "process.spawn", prompt: "Do work" } });
      const explicit = schedules.create({ ...base, target: { kind: "process.spawn", runAs: "algo", prompt: "Do other work" } });
      const other = schedules.create({ ...base, target: { kind: "process.spawn", runAs: "person", prompt: "Unrelated selector" } });
      const cron = schedules.create({ ...base, target: { kind: "command.exec", command: "whoami" } });
      const content = "* * * * * whoami\n";
      schedules.upsertCronFile({ path: "/var/spool/cron/algo", ownerUid: 1001, content, now: 1 });
      schedules.linkCronFileSchedule("/var/spool/cron/algo", cron.id);

      runKernelSqlMigrations(storage);
      runKernelSqlMigrations(storage);
      expect(schedules.get(inherited.id)).toMatchObject({ runAs: { ...principal, username: "ship" }, state: inherited.state });
      expect(schedules.get(explicit.id)?.target).toMatchObject({ runAs: "ship" });
      expect(schedules.get(other.id)?.target).toMatchObject({ runAs: "person" });
      expect(schedules.getCronFile("/var/spool/cron/algo")).toBeNull();
      expect(schedules.cronFileScheduleIds("/var/spool/cron/algo")).toEqual([]);
      expect(schedules.cronFileScheduleIds("/var/spool/cron/ship")).toEqual([cron.id]);
      // SAFETY: these crontab list/read/remove paths use only auth, the actor, and the schedule store; no wake is armed.
      const ctx = { auth, schedules, peer: testPeer({ kind: "human", account: accountIdentity(auth, auth.getPasswdByUid(1001)!), calls: ["sys.sched.*"] }) } as KernelContext;
      const crontabs = createCronFileService(ctx);
      expect(crontabs.listUserCrontabs()).toEqual(["ship"]);
      expect(crontabs.readUserCrontab("ship")).toBe(content);
      expect(await crontabs.removeUserCrontab("ship")).toBe(true);
      expect(schedules.get(cron.id)).toBeNull();
      expect(schedules.cronFileScheduleIds("/var/spool/cron/ship")).toEqual([]);
      expect(schedules.get(inherited.id)).not.toBeNull();
    });
  });

  it.each(["account", "shadow", "group", "home", "crontab", "custom-agent", "unmapped"])("preserves existing names when %s prevents a default rename", async (collision) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      const auth = seed(sql, storage, collision === "custom-agent" ? "friday" : "algo");
      if (collision === "account" || collision === "home") {
        auth.addUser({ username: collision === "account" ? "ship" : "custom", uid: 1002, gid: 1002, home: "/home/ship", gecos: "Custom", shell: "/bin/init" });
      } else if (collision === "group") auth.addGroup({ name: "ship", gid: 1002, members: [] });
      else if (collision === "shadow") auth.setShadow(makeShadowEntry("ship", "reserved-credential"));
      else if (collision === "crontab") new ScheduleStore(sql).upsertCronFile({ path: "/var/spool/cron/ship", ownerUid: 1002, content: "# Keep", now: 1 });
      else if (collision === "unmapped") sql.exec("DELETE FROM personal_agents");
      const before = auth.getPasswdEntries();
      const credentials = sql.exec("SELECT * FROM shadow ORDER BY username").toArray();
      runKernelSqlMigrations(storage);
      expect(auth.getPasswdEntries()).toEqual(before);
      expect(sql.exec("SELECT * FROM shadow ORDER BY username").toArray()).toEqual(credentials);
      expect(accountHomeRepoRef(auth.getPasswdByUid(1001)!)).toEqual({ owner: collision === "custom-agent" ? "friday" : "algo", repo: "home" });
    });
  });
});
