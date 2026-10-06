type PauseAccessOperations = {
  disconnect(): Promise<void>;
  waitForCommands(): Promise<void>;
  revokeMediaGrant(): void;
} & ResourceCleanupOperations;

export type ResourceCleanupOperations = {
  stopNetwork(): Promise<unknown[]>;
  stopRecordings(): Promise<unknown[]>;
  releaseDebuggers(): Promise<number[]>;
};

export type PauseAccessResult = {
  stoppedCaptures: number;
  stoppedRecordings: number;
  detachedTabs: number;
  errors: string[];
  commandsPending: boolean;
};

const COMMAND_WAIT_MS = 2_000;

export async function pauseBrowserResources(
  operations: PauseAccessOperations,
  commandWaitMs = COMMAND_WAIT_MS,
): Promise<PauseAccessResult> {
  const errors: string[] = [];
  operations.revokeMediaGrant();
  const disconnected = operations.disconnect().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`runtime state: ${String(error)}`);
  });
  const first = await releaseBrowserResources(operations);
  await disconnected;
  const commands = operations.waitForCommands().then(
    () => ({ done: true, error: null }),
    (error: unknown) => ({ done: true, error }),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    commands,
    new Promise<{ done: false; error: null }>((resolve) => {
      timeout = setTimeout(() => resolve({ done: false, error: null }), commandWaitMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome.error !== null) errors.push(`browser commands: ${String(outcome.error)}`);
  if (!outcome.done) errors.push("browser commands are still stopping; cleanup will continue when they finish");
  const final = outcome.done ? await releaseBrowserResources(operations) : null;
  return {
    stoppedCaptures: first.stoppedCaptures + (final?.stoppedCaptures ?? 0),
    stoppedRecordings: first.stoppedRecordings + (final?.stoppedRecordings ?? 0),
    detachedTabs: first.detachedTabs + (final?.detachedTabs ?? 0),
    errors: [...errors, ...first.errors, ...(final?.errors ?? [])],
    commandsPending: !outcome.done,
  };
}

export async function releaseBrowserResources(operations: ResourceCleanupOperations): Promise<Omit<PauseAccessResult, "commandsPending">> {
  const errors: string[] = [];
  // Start every teardown before awaiting a Chrome operation that may be slow to finish.
  const stoppedCapturesPromise = operations.stopNetwork().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`network: ${String(error)}`);
    return [];
  });
  const detachedTabsPromise = operations.releaseDebuggers().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`debugger: ${String(error)}`);
    return [];
  });
  const stoppedRecordingsPromise = operations.stopRecordings().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`media: ${String(error)}`);
    return [];
  });
  const [stoppedCaptures, stoppedRecordings, detachedTabs] = await Promise.all([
    stoppedCapturesPromise,
    stoppedRecordingsPromise,
    detachedTabsPromise,
  ]);
  return {
    stoppedCaptures: stoppedCaptures.length,
    stoppedRecordings: stoppedRecordings.length,
    detachedTabs: detachedTabs.length,
    errors,
  };
}
