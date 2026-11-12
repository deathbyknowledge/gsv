import { readFileSync } from "node:fs";
import { DURABLE_OBJECTS } from "@gsv/runtime/config";
import { describe, expect, it } from "vitest";
import { compileWorkerd, compileWrangler, SECRETS } from "../src/compile.ts";
import { testConfig } from "./config.ts";

const paths = { main: "worker.js", ui: "ui", worker: "worker.js", assets: "assets.js" };

describe("config compiler", () => {
  it("emits what the runtime's test config declares", () => {
    const source = readFileSync(new URL("../../runtime/wrangler.test.jsonc", import.meta.url), "utf8");
    const declared = JSON.parse(source.replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown> & { vars: Record<string, string> };
    const compiled = compileWrangler(testConfig(), paths);
    for (const key of ["name", "compatibility_date", "compatibility_flags", "durable_objects", "migrations"] as const) {
      expect(declared[key], key).toEqual(compiled[key]);
    }
    expect(Object.keys(declared.vars).sort()).toEqual([...Object.keys(compiled.vars), ...SECRETS].sort());
  });

  it("binds every class on workerd and reads secrets from the environment", () => {
    const capnp = compileWorkerd(testConfig(), paths);
    for (const { binding, className } of DURABLE_OBJECTS) {
      expect(capnp).toContain(`(name = "${binding}", durableObjectNamespace = "${className}")`);
      expect(capnp).toContain(`(className = "${className}", uniqueKey = "gsv-runtime-test-${className}", enableSql = true)`);
    }
    for (const name of SECRETS) expect(capnp).toContain(`(name = "${name}", fromEnvironment = "${name}")`);
    expect(JSON.stringify(compileWrangler(testConfig(), paths))).not.toMatch(/GSV_SECRET|GSV_SETUP/);
  });

  it("lets only the blob store reach a private network on workerd", () => {
    const plain = compileWorkerd(testConfig(), paths);
    expect(plain).not.toContain("network");
    expect(plain).not.toContain("globalOutbound");
    const s3 = compileWorkerd(testConfig({ selfHost: { s3: { endpoint: "http://127.0.0.1:9000", bucket: "gsv", region: "us-east-1" } } }), paths);
    expect(s3).toContain(`(name = "gsv-s3", network = (allow = ["public", "private", "local"]))`);
    expect(s3).toContain(`(name = "S3_NETWORK", service = "gsv-s3")`);
    expect(s3).toContain(`(name = "S3_SECRET_ACCESS_KEY", fromEnvironment = "S3_SECRET_ACCESS_KEY")`);
    expect(s3).not.toContain("globalOutbound");
  });

  it("refuses services it can't bind yet instead of dropping them", () => {
    const config = testConfig({
      services: { ...testConfig().services, inference: { worker: "gsv-inference" }, messengers: { telegram: { worker: "gsv-telegram" } } },
    });
    expect(() => compileWrangler(config, paths)).toThrow("services.inference, services.messengers.telegram");
    expect(() => compileWorkerd(config, paths)).toThrow("services.inference, services.messengers.telegram");
  });

  it("refuses values that aren't plain text", () => {
    expect(() => compileWorkerd(testConfig({ release: "1.0\n" }), paths)).toThrow("control character");
    expect(compileWorkerd(testConfig({ release: "say \"hi\"" }), paths)).toContain(`text = "say \\"hi\\""`);
  });
});
