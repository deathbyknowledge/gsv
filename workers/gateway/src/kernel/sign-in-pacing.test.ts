import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { getKernelByInstallationId } from "../installation/routing";
import type { Kernel } from "./do";
import { recoverCompletedSysSetup } from "./sys/setup";

const USERNAME = "sam";
const PASSWORD = "the-right-password";
const ROOT_PASSWORD = "the-root-password";
const WAITING = "Too many sign-in attempts. Try again in 1 minute.";

/** A Kernel holding root and one person, each with a password. */
async function withShip(work: (kernel: Kernel) => Promise<void>): Promise<void> {
  const installationId = `inst_pacing_${crypto.randomUUID()}`;
  await runInDurableObject(await getKernelByInstallationId(env.KERNEL, installationId), async (kernel: Kernel) => {
    await kernel.auth.bootstrap();
    kernel.auth.setShadow(makeShadowEntry("root", await hashPassword(ROOT_PASSWORD)));
    kernel.auth.addUser({ username: USERNAME, uid: 1000, gid: 1000, gecos: "Sam", home: `/home/${USERNAME}`, shell: "/bin/init" });
    kernel.auth.updateGroupMembers("users", [USERNAME]);
    kernel.auth.addGroup({ name: USERNAME, gid: 1000, members: [] });
    kernel.auth.setShadow(makeShadowEntry(USERNAME, await hashPassword(PASSWORD)));
    await work(kernel);
  });
}

function gitRead(kernel: Kernel, credential: string, address = "198.51.100.4") {
  return kernel.authorizeGitHttp({ owner: USERNAME, repo: "home", write: false, username: USERNAME, credential, address });
}

describe("signing in with a password", () => {
  it("checks five wrong passwords in a row, then refuses even the right one until the wait is over", async () => {
    await withShip(async (kernel) => {
      const answers: string[] = [];
      for (let count = 0; count < 15; count++) {
        const result = await kernel.auth.authenticate(USERNAME, `wrong-${count}`);
        answers.push(result.ok ? "signed in" : result.error);
      }
      expect(answers).toEqual([...Array<string>(5).fill("Authentication failed"), ...Array<string>(10).fill(WAITING)]);
      const right = await kernel.auth.authenticate(USERNAME, PASSWORD);
      expect(right).toMatchObject({ ok: false, error: WAITING });
      expect(!right.ok && right.waitMs).toBeGreaterThan(25_000);
      // Root has its own run.
      await expect(kernel.auth.authenticate("root", ROOT_PASSWORD)).resolves.toMatchObject({ ok: true });
    });
  });

  it("answers git with 429 and Retry-After while the account waits, and never counts a token as a wrong password", async () => {
    await withShip(async (kernel) => {
      const issued = await kernel.auth.issueToken({ uid: 1000, kind: "human", label: "git" });
      for (let count = 0; count < 12; count++) {
        await expect(gitRead(kernel, issued.token)).resolves.toMatchObject({ ok: true, username: USERNAME });
      }
      await expect(gitRead(kernel, PASSWORD)).resolves.toMatchObject({ ok: true, username: USERNAME });

      for (let count = 0; count < 5; count++) {
        await expect(gitRead(kernel, `wrong-${count}`)).resolves.toEqual({ ok: false, status: 401, message: "Authentication failed" });
      }
      await expect(gitRead(kernel, PASSWORD)).resolves.toEqual({ ok: false, status: 429, message: WAITING, retryAfterSeconds: 30 });
      // A token still works while passwords wait.
      await expect(gitRead(kernel, issued.token)).resolves.toMatchObject({ ok: true, username: USERNAME });
    });
  });

  it("refuses setup's retry with the same answer while the account or its address waits", async () => {
    await withShip(async (kernel) => {
      for (let count = 0; count < 5; count++) await kernel.auth.authenticate(USERNAME, `wrong-${count}`);
      await expect(recoverCompletedSysSetup({ username: USERNAME, password: PASSWORD }, kernel.buildKernelContext({})))
        .rejects.toThrow(WAITING);
    });
    await withShip(async (kernel) => {
      for (let count = 0; count < 20; count++) await kernel.auth.authenticate(`nobody-${count}`, "wrong", "address");
      await expect(recoverCompletedSysSetup({ username: USERNAME, password: PASSWORD }, kernel.buildKernelContext({}), "address"))
        .rejects.toThrow("Too many sign-in attempts. Try again in 60 minutes.");
    });
  });
});
