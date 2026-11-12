import { z } from "zod";
import { profileSchema } from "./profile.ts";

export { DURABLE_OBJECTS } from "./classes.ts";
export { profile, type Profile } from "./profile.ts";

const workerService = z.object({ worker: z.string() });
const none = z.literal("none");

/** One typed file describes a deployment; `gsv dev` and `gsv deploy` compile it for workerd and Cloudflare. */
export const configSchema = z.object({
  /** Names the Worker script and the deployment's resources. */
  name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  release: z.string().min(1),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Spaces live at `<handle>.<domain>`. */
  domain: z.string().min(1),
  profile: profileSchema,
  /** The web UI's built assets, relative to the config file. */
  ui: z.string().min(1),
  /** Only what the runtime itself writes; the UI brands itself. */
  brand: z.object({ product: z.string(), agent: z.string(), mailFrom: z.string() }),
  signup: z.enum(["open", "closed"]),
  operatorSpace: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  templates: z.record(z.string(), z.object({ plan: z.string() })),
  services: z.object({
    inference: z.union([workerService, none]),
    mail: z.union([workerService, none]),
    messengers: z.record(z.string(), z.union([workerService, none])),
    cloud: z.union([workerService, none]),
    search: z.union([workerService, none]),
    telemetry: z.union([z.object({ otlp: z.url() }), none]),
  }),
  plans: z.union([workerService, none]),
  releaseBriefs: z.array(z.object({ id: z.string(), brief: z.string() })),
  /** Where bytes live when self-hosted: an S3-compatible bucket. Credentials come from the environment. */
  selfHost: z.object({ s3: z.object({ endpoint: z.url(), bucket: z.string(), region: z.string() }) }).optional(),
});
export type GsvConfig = z.infer<typeof configSchema>;

export function defineConfig(config: GsvConfig): GsvConfig {
  return configSchema.parse(config);
}
