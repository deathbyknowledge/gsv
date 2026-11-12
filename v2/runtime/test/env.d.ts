import type { Env as RuntimeEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends RuntimeEnv {
      GSV_TEST_SETUP_CODE: string;
    }
  }
}
