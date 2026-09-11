import {
  SINGLETON_INSTALLATION_ID,
  parseInstallationId,
} from "./identity";

import type { InstallationRetirement } from "./retirement";

type R2PutValue =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob;

export function installationStoragePrefix(installationId: string): string {
  const parsed = parseInstallationId(installationId);
  return parsed === SINGLETON_INSTALLATION_ID
    ? ""
    : `installations/${encodeURIComponent(parsed)}/`;
}

// creates an R2 bucket binding that prefixes paths based on installation ID
export function createInstallationStorage(
  bucket: R2Bucket,
  installationId: string,
  retirement?: InstallationRetirement,
): R2Bucket {
  const prefix = installationStoragePrefix(installationId);
  return prefix || retirement ? new InstallationR2Bucket(bucket, prefix, retirement) : bucket;
}

class InstallationR2Bucket implements R2Bucket {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
    private readonly retirement?: InstallationRetirement,
  ) {}

  async head(key: string): Promise<R2Object | null> {
    return mapObject(await this.bucket.head(this.physicalKey(key)), this.prefix);
  }

  get(
    key: string,
    options: R2GetOptions & { onlyIf: R2Conditional | Headers },
  ): Promise<R2ObjectBody | R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  async get(
    key: string,
    options?: R2GetOptions,
  ): Promise<R2ObjectBody | R2Object | null> {
    const physicalKey = this.physicalKey(key);
    const object = options?.onlyIf
      ? await this.bucket.get(physicalKey, { ...options, onlyIf: options.onlyIf })
      : await this.bucket.get(physicalKey, options);
    return mapObject(object, this.prefix);
  }

  put(
    key: string,
    value: R2PutValue,
    options: R2PutOptions & { onlyIf: R2Conditional | Headers },
  ): Promise<R2Object | null>;
  put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object>;
  async put(
    key: string,
    value: R2PutValue,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const physicalKey = this.physicalKey(key);
    const object = await this.write(() => options?.onlyIf
      ? this.bucket.put(physicalKey, value, { ...options, onlyIf: options.onlyIf })
      : this.bucket.put(physicalKey, value, options));
    return mapObject(object, this.prefix);
  }

  async createMultipartUpload(
    key: string,
    options?: R2MultipartOptions,
  ): Promise<R2MultipartUpload> {
    const upload = await this.write(async () => {
      const created = await this.bucket.createMultipartUpload(this.physicalKey(key), options);
      this.retirement?.recordMultipart(created);
      return created;
    });
    return mapMultipartUpload(upload, this.prefix, this.retirement);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    this.retirement?.assertActive();
    const upload = this.bucket.resumeMultipartUpload(this.physicalKey(key), uploadId);
    this.retirement?.recordMultipart(upload);
    return mapMultipartUpload(upload, this.prefix, this.retirement);
  }

  async delete(keys: string | string[]): Promise<void> {
    await this.bucket.delete(
      Array.isArray(keys)
        ? keys.map((key) => this.physicalKey(key))
        : this.physicalKey(keys),
    );
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const physicalOptions: R2ListOptions = {
      ...options,
      prefix: this.physicalKey(options.prefix ?? ""),
    };
    if (options.startAfter !== undefined) {
      physicalOptions.startAfter = this.physicalKey(options.startAfter);
    }
    const result = await this.bucket.list(physicalOptions);
    return {
      ...result,
      objects: result.objects.map((object) => mapObject(object, this.prefix)),
      delimitedPrefixes: result.delimitedPrefixes.map((prefix) => (
        stripPhysicalPrefix(prefix, this.prefix)
      )),
    };
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    return this.retirement ? this.retirement.write(operation) : operation();
  }

  private physicalKey(logicalKey: string): string {
    return `${this.prefix}${logicalKey}`;
  }
}

function mapObject<T extends R2Object>(object: T, prefix: string): T;
function mapObject<T extends R2Object>(object: T | null, prefix: string): T | null;
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
      // SAFETY: Proxy property keys are keys of the wrapped R2 object.
      const value = target[property as keyof T];
      return value instanceof Function ? value.bind(target) : value;
    },
  });
}

function mapMultipartUpload(
  upload: R2MultipartUpload,
  prefix: string,
  retirement?: InstallationRetirement,
): R2MultipartUpload {
  return {
    key: stripPhysicalPrefix(upload.key, prefix),
    uploadId: upload.uploadId,
    uploadPart(partNumber, value, options) {
      return retirement
        ? retirement.write(() => upload.uploadPart(partNumber, value, options))
        : upload.uploadPart(partNumber, value, options);
    },
    async abort() {
      await upload.abort();
      retirement?.forgetMultipart(upload.uploadId);
    },
    async complete(uploadedParts) {
      const complete = async () => {
        const object = await upload.complete(uploadedParts);
        retirement?.forgetMultipart(upload.uploadId);
        return mapObject(object, prefix);
      };
      return retirement ? retirement.write(complete) : complete();
    },
  };
}

function stripPhysicalPrefix(value: string, prefix: string): string {
  if (!value.startsWith(prefix)) {
    throw new Error("R2 returned an object outside the installation storage prefix");
  }
  return value.slice(prefix.length);
}
