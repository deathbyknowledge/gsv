/** Case-insensitive, whitespace-trimmed uniqueness check shared by the console
 *  create flows to block duplicate object names / ids (machine device-ids,
 *  integration names, package names, agent usernames, …) before hitting the
 *  gateway. The gateway stays the authoritative check; this is a pre-submit UX
 *  guard so the user sees the collision inline instead of a thrown error.
 *
 *  `existing` is the list of already-taken identity strings; `candidate` is the
 *  value being entered. An empty/blank candidate is never "taken" (that's the
 *  required-field concern, handled separately). */
export function isNameTaken(existing: readonly string[], candidate: string): boolean {
  const needle = candidate.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return existing.some((value) => value.trim().toLowerCase() === needle);
}
