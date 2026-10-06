type PauseAccessOperations = {
  disconnect(): Promise<void>;
  waitForCommands(): Promise<void>;
  revokeMediaGrant(): void;
  stopNetwork(): Promise<unknown[]>;
  stopRecordings(): Promise<unknown[]>;
  releaseDebuggers(): Promise<number[]>;
};

export type PauseAccessResult = {
  stoppedCaptures: number;
  stoppedRecordings: number;
  detachedTabs: number;
  errors: string[];
};

export async function pauseBrowserResources(operations: PauseAccessOperations): Promise<PauseAccessResult> {
  const errors: string[] = [];
  operations.revokeMediaGrant();
  await operations.disconnect().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`runtime state: ${String(error)}`);
  });
  await operations.waitForCommands().catch((error: unknown) => {
    errors.push(`browser commands: ${String(error)}`);
  });
  const stoppedCaptures = await operations.stopNetwork().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`network: ${String(error)}`);
    return [];
  });
  const stoppedRecordings = await operations.stopRecordings().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`media: ${String(error)}`);
    return [];
  });
  const detachedTabs = await operations.releaseDebuggers().catch((error: unknown) => {
    // SAFETY: rejected browser operations expose Error-compatible values here.
    errors.push(`debugger: ${String(error)}`);
    return [];
  });
  return {
    stoppedCaptures: stoppedCaptures.length,
    stoppedRecordings: stoppedRecordings.length,
    detachedTabs: detachedTabs.length,
    errors,
  };
}
