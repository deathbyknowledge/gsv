import * as Effect from "effect/Effect";
import type { GsvDeploymentManifest } from "./manifest.ts";

export type StandaloneGsvDeploymentProps = {
  manifest: GsvDeploymentManifest;
  adapterIds: readonly string[];
};

export const StandaloneGsvDeployment = (_props: StandaloneGsvDeploymentProps) =>
  Effect.fail(new Error("Legacy standalone deployment is retired by hosting consolidation. Use GsvDeployment with a real installation directory and inference execution service; migrate existing state before upgrading."));
