import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@gsv/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { build, type Build } from "../src/build.ts";
import { issueSetup, newSecret } from "../src/setup.ts";
import { startWorkerd, type Workerd } from "../src/workerd/run.ts";
import { testConfig } from "./config.ts";

/** The same build `gsv dev` and self-hosting run: raw workerd, local-disk objects, the setup link. */
describe("the deployment on raw workerd", () => {
  const setup = issueSetup();
  const env = { GSV_SECRET: newSecret(), GSV_SETUP: setup.binding };
  let dir = "";
  let output: Build;
  let port = 0;
  let workerd: Workerd | undefined;
  const start = () => startWorkerd(output, { data: join(dir, "data"), port, env });
  const origin = (label?: string) => `http://${label ? `${label}.` : ""}localhost:${port}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gsv-workerd-"));
    await mkdir(join(dir, "ui"));
    await mkdir(join(dir, "data"));
    await writeFile(join(dir, "ui", "index.html"), "<p>test ui</p>");
    await writeFile(join(dir, "ui", "app.js"), "// test script");
    output = await build(testConfig({ domain: "localhost" }), { configDir: dir, outDir: join(dir, "build") });
    port = await freePort();
    workerd = await start();
  }, 60_000);

  afterAll(async () => {
    await workerd?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("serves the UI with content types and refuses hosts nobody claimed", async () => {
    for (const [url, type] of [[`${origin()}/`, "text/html"], [`${origin("ops")}/setup`, "text/html"], [`${origin("ops")}/app.js`, "text/javascript"]] as const) {
      const response = await fetch(url);
      expect(response.status, url).toBe(200);
      expect(response.headers.get("content-type"), url).toContain(type);
      await response.body?.cancel();
    }
    expect((await fetch(`${origin("nobody")}/`)).status).toBe(404);
  });

  it("redeems the setup link once and keeps the session across a restart", async () => {
    const redeem = () => fetch(`${origin("ops")}/_gsv/setup`, { method: "POST", body: JSON.stringify({ code: setup.code, name: "Ana" }) });
    const answer = await redeem();
    expect(answer.status).toBe(200);
    const { host, token } = z.object({ host: z.string(), token: z.string() }).parse(await answer.json());
    expect(host).toBe("ops.localhost");

    const first = await connect({ host: `${host}:${port}`, token, insecure: true });
    expect(first.info?.resumed).toBe(true);
    first.close();

    await workerd?.stop();
    workerd = await start();
    const again = await connect({ host: `${host}:${port}`, token, insecure: true });
    expect(again.info?.owner).toBe(first.info?.owner);
    again.close();
    expect((await redeem()).status).toBe(403);
  }, 30_000);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = z.object({ port: z.number() }).parse(server.address());
      server.close(() => resolve(port));
    });
  });
}
