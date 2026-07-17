export type GsvCloudflareComponentPlan = Readonly<{
  id: string;
  bundleRoot: string;
  artifactFile: string;
  required: boolean;
  deployOrder: number;
  dependsOn: readonly string[];
}>;

/**
 * Public GSV deployment topology. Runtime bindings and resources are derived
 * from the bundled Wrangler configurations; this list only owns product-level
 * component identity, required topology, and deployment sequencing.
 */
export const GSV_CLOUDFLARE_COMPONENT_PLAN = Object.freeze([
  Object.freeze({
    id: "ripgit",
    bundleRoot: "ripgit",
    artifactFile: "gsv-cloudflare-ripgit.tar.gz",
    required: true,
    deployOrder: 10,
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    id: "assembler",
    bundleRoot: "assembler",
    artifactFile: "gsv-cloudflare-assembler.tar.gz",
    required: true,
    deployOrder: 20,
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    id: "channel-whatsapp",
    bundleRoot: "channel-whatsapp",
    artifactFile: "gsv-cloudflare-channel-whatsapp.tar.gz",
    required: true,
    deployOrder: 30,
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    id: "channel-discord",
    bundleRoot: "channel-discord",
    artifactFile: "gsv-cloudflare-channel-discord.tar.gz",
    required: true,
    deployOrder: 40,
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    id: "channel-telegram",
    bundleRoot: "channel-telegram",
    artifactFile: "gsv-cloudflare-channel-telegram.tar.gz",
    required: true,
    deployOrder: 50,
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    id: "gateway",
    bundleRoot: "gateway",
    artifactFile: "gsv-cloudflare-gateway.tar.gz",
    required: true,
    deployOrder: 60,
    dependsOn: Object.freeze([
      "assembler",
      "channel-discord",
      "channel-telegram",
      "channel-whatsapp",
      "ripgit",
    ]),
  }),
] satisfies readonly GsvCloudflareComponentPlan[]);

/** Codec features implemented by the Workers in this release family. */
export const GSV_CLOUDFLARE_PORTABLE_FEATURES = Object.freeze([
  "gsv-do-logical-snapshot-v1",
  "gsv-r2-logical-snapshot-v1",
  "gsv-ripgit-logical-snapshot-v1",
] as const);
