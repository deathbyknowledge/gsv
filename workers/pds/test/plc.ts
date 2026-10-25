import { encode } from "@atcute/cbor";
import { CODEC_DCBOR, create, toString } from "@atcute/cid";
import { parseDidKey } from "@atcute/crypto";
import {
  normalizeOp,
  processIndexedEntry,
  type CompatibleOperationOrTombstone,
  type DidPlcString,
  type IndexedEntryWithSigner,
} from "@atcute/did-plc";

/**
 * An in-memory did:plc directory. It accepts an operation only when the log
 * rules plc.directory applies would, and serves logs and documents in its format.
 * The Gateway's tests use it too, so it imports nothing from the PDS.
 */
export class FakePlcDirectory {
  private readonly logs = new Map<string, IndexedEntryWithSigner[]>();
  private dropNextResponse = false;
  private elapsedMs = 0;

  /** Logs the next valid operation but fails its response, as a dropped connection does. */
  loseNextResponse(): void {
    this.dropNextResponse = true;
  }

  /** Moves the directory's clock on, so the operations it logs next carry a later time. */
  elapse(ms: number): void {
    this.elapsedMs += ms;
  }

  /** The operations a DID's log holds, genesis first. */
  operations(did: string): CompatibleOperationOrTombstone[] {
    return (this.logs.get(did) ?? []).map((entry) => entry.operation);
  }

  async handle(request: Request): Promise<Response> {
    const [encoded = "", ...rest] = new URL(request.url).pathname.slice(1).split("/");
    const did = decodeURIComponent(encoded);
    const path = rest.join("/");
    if (!isDidPlc(did)) return Response.json({ message: `Invalid DID: ${did}` }, { status: 400 });
    if (request.method === "POST" && path === "") {
      return this.submit(did, await request.json<CompatibleOperationOrTombstone>());
    }
    const log = this.logs.get(did);
    const last = log?.at(-1)?.operation;
    if (!log || !last) return Response.json({ message: `DID not registered: ${did}` }, { status: 404 });
    if (path === "log") return Response.json(log.map((entry) => entry.operation));
    if (path === "log/audit") return Response.json(log.map(({ allowedSigners: _allowed, signedBy: _signer, ...entry }) => entry));
    if (path !== "") return Response.json({ message: "Not found" }, { status: 404 });
    if (last.type === "plc_tombstone") return Response.json({ message: `DID not available: ${did}` }, { status: 404 });
    return Response.json(didDocument(did, normalizeOp(last)), { headers: { "content-type": "application/did+ld+json" } });
  }

  private async submit(did: DidPlcString, operation: CompatibleOperationOrTombstone): Promise<Response> {
    try {
      const { ops } = await processIndexedEntry(did, this.logs.get(did) ?? [], {
        did,
        operation,
        cid: toString(await create(CODEC_DCBOR, encode(operation))),
        nullified: false,
        createdAt: new Date(Date.now() + this.elapsedMs).toISOString(),
      });
      this.logs.set(did, ops);
    } catch (error) {
      return Response.json({ message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new TypeError("Network connection lost.");
    }
    return new Response(null, { status: 200 });
  }
}

/** A DID document in plc.directory's format. */
export type PlcDocument = {
  "@context": string[];
  id: string;
  alsoKnownAs: string[];
  verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  service: { id: string; type: string; serviceEndpoint: string }[];
};

/** The document plc.directory serves for an operation's state. */
function didDocument(did: string, state: ReturnType<typeof normalizeOp>): PlcDocument {
  const context = ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"];
  const verificationMethod = Object.entries(state.verificationMethods).map(([id, key]) => {
    if (parseDidKey(key).type !== "secp256k1") throw new Error("The fake directory formats secp256k1 keys only");
    const suite = "https://w3id.org/security/suites/secp256k1-2019/v1";
    if (!context.includes(suite)) context.push(suite);
    return { id: `${did}#${id}`, type: "Multikey", controller: did, publicKeyMultibase: key.slice("did:key:".length) };
  });
  return {
    "@context": context,
    id: did,
    alsoKnownAs: state.alsoKnownAs,
    verificationMethod,
    service: Object.entries(state.services).map(([id, service]) => ({
      id: `#${id}`,
      type: service.type,
      serviceEndpoint: service.endpoint,
    })),
  };
}

export function isDidPlc(value: string): value is DidPlcString {
  return value.startsWith("did:plc:");
}
