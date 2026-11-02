/** A wall-clock budget for work that can stop to ask a person, whose answer time is not the work's own. */
export type ExecutionDeadline = { clear(): void };

/** The deadlines that belong to one tool execution, held together while a person is being asked. */
export class ExecutionDeadlines {
  private readonly live = new Set<{ pause(): void; resume(): void }>();
  private holds = 0;

  start(ms: number, onExpire: () => void): ExecutionDeadline {
    let remainingMs = ms;
    let startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = {
      pause: () => {
        clearTimeout(timer);
        remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
      },
      resume: () => {
        startedAt = Date.now();
        timer = setTimeout(() => {
          this.live.delete(entry);
          onExpire();
        }, remainingMs);
      },
    };
    this.live.add(entry);
    if (this.holds === 0) entry.resume();
    return {
      clear: () => {
        clearTimeout(timer);
        this.live.delete(entry);
      },
    };
  }

  /** Stops every running deadline until the returned release is called. */
  hold(): () => void {
    if (this.holds++ === 0) for (const entry of this.live) entry.pause();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0) for (const entry of this.live) entry.resume();
    };
  }
}
