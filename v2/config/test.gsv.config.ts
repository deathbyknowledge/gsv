import { defineConfig } from "@gsv/runtime/config";
import ship from "../ship/profile.ts";

/**
 * The 2.0 test deployment on Cloudflare. Its zone isn't chosen yet: the `.invalid` domain keeps a deploy
 * from reaching anything until it is (spec 15, The test deployment). R2 bucket: `gsv-2-test-blobs`.
 */
export default defineConfig({
  name: "gsv-2-test",
  release: "2.0.0-m0",
  compatibilityDate: "2026-08-01",
  domain: "gsv-2-test.invalid",
  profile: ship,
  ui: "../ship/web/dist",
  brand: { product: "Ship", agent: "Ship", mailFrom: "Ship" },
  signup: "closed",
  operatorSpace: "ops",
  templates: { personal: { plan: "included" } },
  services: { inference: "none", mail: "none", messengers: {}, cloud: "none", search: "none", telemetry: "none" },
  plans: "none",
  releaseBriefs: [],
});
