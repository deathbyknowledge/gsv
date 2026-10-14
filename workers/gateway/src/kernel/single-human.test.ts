import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { makeShadowEntry, hashPassword } from "../auth/shadow";
import { AuthStore } from "./auth-store";

describe("personal account invariant", () => {
  it("retains the existing identity and rejects a second human through direct and filesystem credential writes", async () => {
    await runWithRealKernelSql(async (sql) => {
      const auth = new AuthStore(sql);
      await auth.bootstrap();
      auth.addUser({ username: "existing", uid: 1042, gid: 1042, home: "/home/existing", shell: "/bin/init", gecos: "My name" });
      auth.setShadow(makeShadowEntry("existing", await hashPassword("personal-password")));
      auth.addUser({ username: "agent", uid: 1043, gid: 1043, home: "/home/agent", shell: "/bin/init", gecos: "Agent" });
      auth.setShadow(makeShadowEntry("agent", "!"));
      const before = auth.getShadowEntries();
      expect(() => auth.setShadow(makeShadowEntry("agent", "another-hash"))).toThrow("one personal account");
      await expect(auth.setPassword("agent", "another-hash")).rejects.toThrow("one personal account");
      expect(() => auth.importShadow("existing:existing-hash:::::::\nagent:another-hash:::::::")).toThrow("one personal account");
      expect(auth.getShadowEntries()).toEqual(before);
      expect(new AuthStore(sql).getHumanAccount()).toMatchObject({ username: "existing", uid: 1042, home: "/home/existing" });
      expect(await auth.authenticate("existing", "personal-password")).toMatchObject({ ok: true });
    });
  });
});
