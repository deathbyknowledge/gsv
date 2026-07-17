export type FirstBootSetupLease = Readonly<{
  generation: number;
}>;

export type FirstBootAssistLease = Readonly<{
  generation: number;
}>;

/**
 * Serializes the only mutating pre-auth operation owned by the Kernel.
 *
 * Setup-assist calls may run concurrently, but starting a setup invalidates
 * every assist that began against the previous first-boot state. This keeps a
 * late model response from being delivered after setup has superseded it.
 */
export class FirstBootAdmission {
  private generation = 0;
  private activeSetup: FirstBootSetupLease | null = null;

  beginSetup(): FirstBootSetupLease | null {
    if (this.activeSetup) return null;
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error("First-boot admission generation exhausted");
    }
    const lease = Object.freeze({ generation: this.generation + 1 });
    this.generation = lease.generation;
    this.activeSetup = lease;
    return lease;
  }

  finishSetup(lease: FirstBootSetupLease): void {
    if (this.activeSetup !== lease) {
      throw new Error("First-boot setup lease is not active");
    }
    this.activeSetup = null;
  }

  beginAssist(): FirstBootAssistLease | null {
    if (this.activeSetup) return null;
    return Object.freeze({ generation: this.generation });
  }

  isAssistCurrent(lease: FirstBootAssistLease): boolean {
    return this.activeSetup === null && lease.generation === this.generation;
  }
}
