/**
 * Replace an alarm when none exists, its deadline has passed, or the requested
 * deadline is earlier. Preserve an already-scheduled earlier future wake-up.
 */
export function shouldReplaceAlarm(
  currentAlarm: number | null,
  requestedAlarm: number,
  now: number,
): boolean {
  return currentAlarm === null
    || currentAlarm <= now
    || currentAlarm > requestedAlarm;
}
