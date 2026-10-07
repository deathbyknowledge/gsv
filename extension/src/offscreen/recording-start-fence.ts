export class RecordingStartFence {
  private stoppedGeneration = 0;

  generation(): number {
    return this.stoppedGeneration;
  }

  stop(): void {
    this.stoppedGeneration += 1;
  }

  async acquire<T>(
    generation: number,
    acquire: () => Promise<T>,
    release: (resource: T) => void,
    isPaused: () => Promise<boolean>,
  ): Promise<T> {
    await this.assertCurrent(generation, isPaused);
    const resource = await acquire();
    try {
      await this.assertCurrent(generation, isPaused);
      return resource;
    } catch (error) {
      release(resource);
      throw error;
    }
  }

  private async assertCurrent(generation: number, isPaused: () => Promise<boolean>): Promise<void> {
    if (generation !== this.stoppedGeneration) {
      throw new Error("Browser access was paused before recording started");
    }
    const paused = await isPaused();
    if (paused || generation !== this.stoppedGeneration) {
      throw new Error("Browser access was paused before recording started");
    }
  }
}
