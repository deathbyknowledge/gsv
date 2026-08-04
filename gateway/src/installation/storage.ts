import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseInstallationId,
  type InstallationId,
} from "./identity";

export function installationStoragePrefix(
  installationId: InstallationId | string,
): string {
  const parsed = parseInstallationId(installationId);
  if (parsed === LEGACY_STANDALONE_INSTALLATION_ID) {
    return "";
  }
  return `installations/${encodeURIComponent(parsed)}/`;
}

export function installationStorageKey(
  installationId: InstallationId | string,
  logicalKey: string,
): string {
  return `${installationStoragePrefix(installationId)}${logicalKey}`;
}

/**
 * Present one installation's R2 namespace as an ordinary bucket. Runtime code
 * continues to store logical filesystem/media/archive keys while this boundary
 * applies the physical installation prefix.
 */
export function createInstallationStorage(
  bucket: R2Bucket,
  installationId: InstallationId | string,
): R2Bucket {
  const prefix = installationStoragePrefix(installationId);
  if (!prefix) {
    return bucket;
  }
  return new InstallationR2Bucket(bucket, prefix) as unknown as R2Bucket;
}

class InstallationR2Bucket {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
  ) {}

  async head(key: string): Promise<R2Object | null> {
    return mapObject(await this.bucket.head(this.physicalKey(key)), this.prefix);
  }

  async get(
    key: string,
    options?: R2GetOptions,
  ): Promise<R2ObjectBody | R2Object | null> {
    return mapObject(
      await this.bucket.get(this.physicalKey(key), options as R2GetOptions),
      this.prefix,
    );
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    return mapObject(
      await this.bucket.put(this.physicalKey(key), value, options),
      this.prefix,
    );
  }

  async createMultipartUpload(
    key: string,
    options?: R2MultipartOptions,
  ): Promise<R2MultipartUpload> {
    const upload = await this.bucket.createMultipartUpload(this.physicalKey(key), options);
    return mapMultipartUpload(upload, this.prefix);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    return mapMultipartUpload(
      this.bucket.resumeMultipartUpload(this.physicalKey(key), uploadId),
      this.prefix,
    );
  }

  async delete(keys: string | string[]): Promise<void> {
    await this.bucket.delete(
      Array.isArray(keys)
        ? keys.map((key) => this.physicalKey(key))
        : this.physicalKey(keys),
    );
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const result = await this.bucket.list({
      ...options,
      prefix: this.physicalKey(options.prefix ?? ""),
      ...(options.startAfter !== undefined
        ? { startAfter: this.physicalKey(options.startAfter) }
        : {}),
    });
    return {
      ...result,
      objects: result.objects.map((object) => mapObject(object, this.prefix)!),
      delimitedPrefixes: result.delimitedPrefixes.map((value) => (
        stripPhysicalPrefix(value, this.prefix)
      )),
    };
  }

  private physicalKey(logicalKey: string): string {
    return `${this.prefix}${logicalKey}`;
  }
}

function mapObject<T extends R2Object>(object: T | null, prefix: string): T | null {
  if (!object) {
    return null;
  }
  const logicalKey = stripPhysicalPrefix(object.key, prefix);
  return new Proxy(object, {
    get(target, property) {
      if (property === "key") {
        return logicalKey;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function mapMultipartUpload(upload: R2MultipartUpload, prefix: string): R2MultipartUpload {
  const logicalKey = stripPhysicalPrefix(upload.key, prefix);
  return {
    get key() {
      return logicalKey;
    },
    get uploadId() {
      return upload.uploadId;
    },
    uploadPart(partNumber, value, options) {
      return upload.uploadPart(partNumber, value, options);
    },
    abort() {
      return upload.abort();
    },
    async complete(uploadedParts) {
      return mapObject(await upload.complete(uploadedParts), prefix)!;
    },
  };
}

function stripPhysicalPrefix(value: string, prefix: string): string {
  if (!value.startsWith(prefix)) {
    throw new Error("R2 returned an object outside the installation storage prefix");
  }
  return value.slice(prefix.length);
}
