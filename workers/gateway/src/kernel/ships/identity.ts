const SHIP_DID_KEY = "ship_did_v1";

/**
 * This Ship's own DID, kept beside the Kernel once its repository on the PDS
 * holds one, so checking incoming calls doesn't wait on the PDS.
 */
export class ShipIdentity {
  constructor(private readonly storage: DurableObjectStorage) {}

  current(): string | null {
    return this.storage.kv.get<string>(SHIP_DID_KEY) ?? null;
  }

  remember(did: string): void {
    const known = this.current();
    if (known === did) return;
    // A repository holds one DID for good; a different one means storage was crossed.
    if (known) throw new Error("This Ship already has another DID");
    this.storage.kv.put(SHIP_DID_KEY, did);
  }
}
