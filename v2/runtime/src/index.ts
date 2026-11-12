import { edge } from "./edge/edge.ts";
import type { Env } from "./env.ts";

export { Directory } from "./directory/directory.ts";
export { Owner } from "./owner/owner.ts";
export { Process } from "./process/process.ts";
export { Space } from "./space/space.ts";
export { Target } from "./target/target.ts";
export { Volume } from "./volume/volume.ts";
export type { Env } from "./env.ts";

export default {
  fetch: (request, env) => edge(request, env),
} satisfies ExportedHandler<Env>;
