export type ProvisioningR2BucketMock = Pick<R2Bucket, "head" | "put"> & {
  readonly objects: ReadonlyMap<string, R2Object>;
};

/**
 * Minimal in-memory R2 bucket for unit tests that exercise trusted directory
 * provisioning. Unlike a no-op put stub, it preserves objects and implements
 * the conditional writes used by the production create-only primitive.
 */
export function createProvisioningR2BucketMock(): ProvisioningR2BucketMock {
  const objects = new Map<string, R2Object>();
  let nextVersion = 1;

  const bucket = {
    objects,
    async head(key: string): Promise<R2Object | null> {
      return objects.get(key) ?? null;
    },
    async put(
      key: string,
      _value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ): Promise<R2Object | null> {
      const existing = objects.get(key) ?? null;
      if (!conditionalWriteAllowed(existing, options?.onlyIf)) {
        return null;
      }

      const version = String(nextVersion++);
      const etag = `test-etag-${version}`;
      const object = {
        key,
        version,
        size: 0,
        etag,
        httpEtag: `"${etag}"`,
        checksums: { toJSON: () => ({}) },
        uploaded: new Date(0),
        customMetadata: options?.customMetadata
          ? { ...options.customMetadata }
          : undefined,
        storageClass: options?.storageClass ?? "Standard",
        writeHttpMetadata: () => {},
      } as unknown as R2Object;
      objects.set(key, object);
      return object;
    },
  };

  return bucket as unknown as ProvisioningR2BucketMock;
}

function conditionalWriteAllowed(
  existing: R2Object | null,
  onlyIf: R2Conditional | Headers | undefined,
): boolean {
  if (!onlyIf) {
    return true;
  }

  const etagMatches = onlyIf instanceof Headers
    ? onlyIf.get("if-match") ?? undefined
    : onlyIf.etagMatches;
  const etagDoesNotMatch = onlyIf instanceof Headers
    ? onlyIf.get("if-none-match") ?? undefined
    : onlyIf.etagDoesNotMatch;

  if (etagMatches === "*" && !existing) {
    return false;
  }
  if (etagMatches && etagMatches !== "*" && existing?.etag !== unquoteEtag(etagMatches)) {
    return false;
  }
  if (etagDoesNotMatch === "*" && existing) {
    return false;
  }
  if (
    etagDoesNotMatch
    && etagDoesNotMatch !== "*"
    && existing?.etag === unquoteEtag(etagDoesNotMatch)
  ) {
    return false;
  }
  return true;
}

function unquoteEtag(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}
