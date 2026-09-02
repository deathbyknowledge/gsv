import { DockerExecEnvironment } from "./docker-environment";
import {
  SyntheticCapabilityEnvironment,
  type SyntheticTargetEnvironment,
} from "./environment";
import { PrimeSandboxEnvironment } from "./prime-sandbox-environment";
import type { SyntheticTargetSpec } from "./schema";

export type SyntheticTargetFactory = (
  spec: SyntheticTargetSpec,
) => SyntheticTargetEnvironment;

export class SyntheticTargetRegistry {
  private readonly factories = new Map<string, SyntheticTargetFactory>();

  constructor() {
    this.register("memory", (spec) => new SyntheticCapabilityEnvironment(spec));
    this.register("docker-exec", (spec) => new DockerExecEnvironment(spec));
    this.register("prime-sandbox", (spec) => new PrimeSandboxEnvironment(spec));
  }

  register(driver: string, factory: SyntheticTargetFactory): void {
    const normalized = driver.trim();
    if (!normalized) throw new Error("Synthetic target driver cannot be empty");
    if (this.factories.has(normalized)) {
      throw new Error("Duplicate synthetic target driver: " + normalized);
    }
    this.factories.set(normalized, factory);
  }

  create(spec: SyntheticTargetSpec): SyntheticTargetEnvironment {
    const driver = spec.driver ?? "memory";
    const factory = this.factories.get(driver);
    if (!factory) throw new Error("Unknown synthetic target driver: " + driver);
    return factory({ ...spec, driver });
  }
}
