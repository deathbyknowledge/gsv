/** Internal v1 state machine for one contiguous frame run per logical object. */
export class ContiguousObjectRunTracker {
  #currentObjectId: string | null = null;
  readonly #closedObjectIds = new Set<string>();

  observe(objectId: string, fail: (message: string) => never): void {
    if (objectId === this.#currentObjectId) return;
    if (this.#currentObjectId !== null) {
      this.#closedObjectIds.add(this.#currentObjectId);
    }
    if (this.#closedObjectIds.has(objectId)) {
      fail("v1 archive frames for each object must form one contiguous run");
    }
    this.#currentObjectId = objectId;
  }
}
