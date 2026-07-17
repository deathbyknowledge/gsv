type ObjectStorageEnvironment = {
  GSV_MAX_R2_OBJECT_BYTES?: unknown;
};

export function r2ObjectLimit(env: ObjectStorageEnvironment): number | undefined {
  const configured = env.GSV_MAX_R2_OBJECT_BYTES;
  if (configured === undefined) return undefined;
  if (typeof configured !== "string" || !/^[1-9][0-9]*$/.test(configured)) {
    throw new Error("GSV_MAX_R2_OBJECT_BYTES must be a positive integer");
  }
  const limit = Number(configured);
  if (!Number.isSafeInteger(limit)) {
    throw new Error("GSV_MAX_R2_OBJECT_BYTES must be a positive safe integer");
  }
  return limit;
}

export function assertR2ObjectSize(
  maximum: number | undefined,
  size: number,
): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("R2 object size must be a non-negative safe integer");
  }
  if (maximum !== undefined && size > maximum) {
    throw new Error(`EFBIG: storage object exceeds ${maximum} bytes`);
  }
}

export function contentBytes(content: string | Uint8Array | ArrayBuffer): number {
  if (typeof content === "string") {
    return new TextEncoder().encode(content).byteLength;
  }
  return content.byteLength;
}
