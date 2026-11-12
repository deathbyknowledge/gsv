import { configSchema, profile, type GsvConfig } from "@gsv/runtime/config";

/** A deployment with every service off, matching the runtime's own test config. */
export function testConfig(overrides: Partial<GsvConfig> = {}): GsvConfig {
  return configSchema.parse({
    name: "gsv-runtime-test",
    release: "test",
    compatibilityDate: "2026-08-01",
    domain: "gsv.test",
    profile: profile({ name: "test" }),
    ui: "ui",
    brand: { product: "Test", agent: "Agent", mailFrom: "Test" },
    signup: "closed",
    operatorSpace: "ops",
    templates: {},
    services: { inference: "none", mail: "none", messengers: {}, cloud: "none", search: "none", telemetry: "none" },
    plans: "none",
    releaseBriefs: [],
    ...overrides,
  });
}
