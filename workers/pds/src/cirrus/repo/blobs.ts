import {
	create as createCid,
	CODEC_RAW,
	toString as cidToString,
} from "@atcute/cid";

export interface BlobRef {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

/**
 * R2 key layout for blobs, after the store's optional key prefix:
 *
 *   `${did}/staged/${cid}` – uploaded, not yet referenced by any record.
 *     Served by nothing; expired by an R2 lifecycle rule after seven days.
 *     A host that streams uploads names the staged copy itself, since the
 *     CID is only known once every byte has arrived.
 *   `${did}/${cid}`        – referenced by at least one public record.
 *     Served by com.atproto.sync.getBlob.
 *
 * Uploads land in `staged/` and are promoted (copied) to their destination
 * key when a record write first references them. The copy completes before
 * the commit is applied, so anything reacting to the commit never sees a
 * 404. Keys never move back: promotion is idempotent and `staged/` copies
 * are left for the lifecycle rule to reap.
 *
 * A host whose key prefix keeps lifecycle rules from matching `staged/`
 * deletes those copies itself with deleteStagedBlob, and removes a public
 * copy with deleteBlob once no record references it.
 */
function stagedBlobKey(prefix: string, did: string, cid: string): string {
	return `${prefix}${did}/staged/${cid}`;
}

function publicBlobKey(prefix: string, did: string, cid: string): string {
	return `${prefix}${did}/${cid}`;
}

/**
 * Extract blob CIDs from a record in JSON form (as received from clients),
 * recursively searching for blob references. Handles both the current
 * `{ $type: "blob", ref: { $link }, mimeType, size }` shape and the legacy
 * untyped `{ cid, mimeType }` shape.
 */
export function extractJsonBlobCids(value: unknown): string[] {
	const cids = new Set<string>();
	walkForBlobRefs(value, cids);
	return Array.from(cids);
}

function walkForBlobRefs(value: unknown, out: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) walkForBlobRefs(item, out);
		return;
	}
	if (value === null || typeof value !== "object") return;

	const obj = value as Record<string, unknown>;

	if (
		obj.$type === "blob" &&
		typeof obj.ref === "object" &&
		obj.ref !== null &&
		typeof (obj.ref as Record<string, unknown>).$link === "string"
	) {
		out.add((obj.ref as { $link: string }).$link);
		return;
	}

	// Legacy blob ref: { cid: string, mimeType: string } with no $type
	if (
		obj.$type === undefined &&
		typeof obj.cid === "string" &&
		typeof obj.mimeType === "string"
	) {
		out.add(obj.cid);
		return;
	}

	for (const key of Object.keys(obj)) {
		walkForBlobRefs(obj[key], out);
	}
}

/**
 * BlobStore manages blob storage in R2.
 * Blobs are stored with CID-based keys prefixed by the account's DID.
 */
export class BlobStore {
	constructor(
		private r2: R2Bucket,
		private did: string,
		/** Prepended verbatim to every key, e.g. to scope a shared bucket per tenant. */
		private keyPrefix = "",
	) {}

	/**
	 * Upload a blob to R2 staging and return a BlobRef.
	 *
	 * The blob is not fetchable until a record write references it, which
	 * promotes it to its serving key.
	 */
	async putBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		// Compute CID using SHA-256 (RAW codec)
		const cidObj = await createCid(CODEC_RAW, bytes);
		const cidStr = cidToString(cidObj);

		await this.r2.put(stagedBlobKey(this.keyPrefix, this.did, cidStr), bytes, {
			httpMetadata: { contentType: mimeType },
		});

		return {
			$type: "blob",
			ref: { $link: cidStr },
			mimeType,
			size: bytes.length,
		};
	}

	/**
	 * Stream an upload into staging under a name the host chooses, for an
	 * upload whose CID is only known once every byte has arrived. R2 needs
	 * the body's length up front.
	 */
	async putStaged(name: string, body: ReadableStream, mimeType: string): Promise<void> {
		await this.r2.put(stagedBlobKey(this.keyPrefix, this.did, name), body, {
			httpMetadata: { contentType: mimeType },
		});
	}

	/**
	 * Retrieve a staged copy by its name: its CID, or the name the host gave it.
	 */
	async getStagedBlob(name: string): Promise<R2ObjectBody | null> {
		return this.r2.get(stagedBlobKey(this.keyPrefix, this.did, name));
	}

	/**
	 * Promote a staged blob to a destination key with a streaming copy.
	 *
	 * Idempotent: returns early when the destination already exists, so
	 * concurrent writes referencing the same staged blob are safe. A CID
	 * that is neither staged nor at the destination is skipped — records
	 * may reference blobs from before this layout existed, and reference
	 * checking is not this method's job.
	 */
	private async promoteTo(cid: string, destKey: string, stagedName = cid): Promise<void> {
		if (await this.r2.head(destKey)) return;

		const staged = await this.r2.get(stagedBlobKey(this.keyPrefix, this.did, stagedName));
		if (!staged) return;

		await this.r2.put(destKey, staged.body, {
			httpMetadata: staged.httpMetadata,
		});
	}

	/**
	 * Promote a staged blob to the public serving key. A staged copy the host
	 * named itself is promoted by that name.
	 */
	async promoteBlob(cid: string, stagedName = cid): Promise<void> {
		await this.promoteTo(cid, publicBlobKey(this.keyPrefix, this.did, cid), stagedName);
	}

	/**
	 * Promote several staged blobs to the public serving key.
	 */
	async promoteBlobs(cids: string[]): Promise<void> {
		await Promise.all(cids.map((cid) => this.promoteBlob(cid)));
	}

	/**
	 * Retrieve a public blob from R2 by CID string.
	 */
	async getBlob(cid: string): Promise<R2ObjectBody | null> {
		return this.r2.get(publicBlobKey(this.keyPrefix, this.did, cid));
	}

	/**
	 * Check if a blob exists at the public serving key.
	 */
	async hasBlob(cid: string): Promise<boolean> {
		const head = await this.r2.head(publicBlobKey(this.keyPrefix, this.did, cid));
		return head !== null;
	}

	/**
	 * Delete a blob's public copy, once no record references it.
	 */
	async deleteBlob(cid: string): Promise<void> {
		await this.r2.delete(publicBlobKey(this.keyPrefix, this.did, cid));
	}

	/**
	 * Delete a blob's staged copy, after promotion or when an unreferenced
	 * upload expires. The copy is named by its CID, or by the name the host
	 * gave it.
	 */
	async deleteStagedBlob(name: string): Promise<void> {
		await this.r2.delete(stagedBlobKey(this.keyPrefix, this.did, name));
	}
}
