import { defineConfig } from "@gsv/runtime/config";
import ship from "../ship/profile.ts";

/** Ship on this machine: `npm run dev` serves it at http://localhost:8787 with every service off. */
export default defineConfig({
  name: "gsv-local",
  release: "2.0.0-dev",
  compatibilityDate: "2026-08-01",
  domain: "localhost",
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
