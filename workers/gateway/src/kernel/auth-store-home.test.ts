import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { runKernelSqlMigrations } from "./schema/migrations";

describe("account home ownership", () => {
  it.each(["create", "update", "import"])("rejects shared custom homes before %s mutates passwd", async (operation) => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runKernelSqlMigrations(storage);
      const auth = new AuthStore(sql);
      auth.addUser({ username: "one", uid: 1000, gid: 1000, home: "/home/shared", gecos: "One", shell: "/bin/init" });
      auth.addUser({ username: "two", uid: 1001, gid: 1001, home: "/home/two", gecos: "Two", shell: "/bin/init" });
      const before = auth.getPasswdEntries();
      const collide = () => {
        if (operation === "create") {
          auth.addUser({ username: "three", uid: 1002, gid: 1002, home: "/home/./shared/", gecos: "Three", shell: "/bin/init" });
        } else if (operation === "update") {
          auth.updateUser("two", { home: "/home/./shared/" });
        } else {
          auth.importPasswd(auth.serializePasswd().replace(":/home/two:", ":/home/./shared/:"));
        }
      };
      expect(collide).toThrow("Home or repository namespace already belongs to account: one");
      expect(auth.getPasswdEntries()).toEqual(before);
    });
  });

  it("rejects ambiguous legacy home routing and allows root to correct it", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      await storage.deleteAll();
      runKernelSqlMigrations(storage);
      const auth = new AuthStore(sql);
      auth.addUser({ username: "one", uid: 1000, gid: 1000, home: "/home/shared", gecos: "One", shell: "/bin/init" });
      auth.addUser({ username: "two", uid: 1001, gid: 1001, home: "/home/two", gecos: "Two", shell: "/bin/init" });
      sql.exec("UPDATE passwd SET home = '/home/./shared/' WHERE username = 'two'");
      expect(() => auth.getPasswdByHome("/home/shared")).toThrow("Ambiguous account home");
      auth.importPasswd(auth.serializePasswd().replace(":/home/./shared/:", ":/home/two:"));
      expect(auth.getPasswdByHome("/home/shared")?.username).toBe("one");
      expect(auth.getPasswdByHome("/home/two")?.username).toBe("two");
    });
  });
});
