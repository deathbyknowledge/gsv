const TAR_BLOCK_BYTES = 512;
const TAR_MAX_OCTAL_SIZE = 8_589_934_591;
const encoder = new TextEncoder();

export type TarEntry = {
  path: string;
  size: number;
  body: Uint8Array | ReadableStream<Uint8Array>;
  modifiedAt?: number;
  mode?: number;
};

type TarStreamState = {
  activeReader: ReadableStreamDefaultReader<Uint8Array> | null;
  activeBody: ReadableStream<Uint8Array> | null;
  cancelled: boolean;
};

export function createTarStream(
  entries: AsyncIterable<TarEntry>,
): ReadableStream<Uint8Array> {
  const state: TarStreamState = {
    activeReader: null,
    activeBody: null,
    cancelled: false,
  };
  const iterator = tarChunks(entries, state)[Symbol.asyncIterator]();
  let activePull: Promise<IteratorResult<Uint8Array>> | null = null;
  return new ReadableStream({
    type: "bytes",
    async pull(controller): Promise<void> {
      try {
        activePull = iterator.next();
        const next = await activePull;
        if (state.cancelled) return;
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (!state.cancelled) controller.error(error);
      } finally {
        activePull = null;
      }
    },
    async cancel(reason): Promise<void> {
      state.cancelled = true;
      await cancelActiveBody(state);
      await activePull?.catch(() => undefined);
      await iterator.return?.(reason);
    },
  } as UnderlyingByteSource) as ReadableStream<Uint8Array>;
}

export function tarJsonEntry(
  path: string,
  value: unknown,
  modifiedAt?: number,
): TarEntry {
  const body = encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
  return { path, size: body.byteLength, body, modifiedAt };
}

export function tarTextEntry(
  path: string,
  value: string,
  modifiedAt?: number,
): TarEntry {
  const body = encoder.encode(value);
  return { path, size: body.byteLength, body, modifiedAt };
}

async function* tarChunks(
  entries: AsyncIterable<TarEntry>,
  state: TarStreamState,
): AsyncGenerator<Uint8Array> {
  let index = 0;
  try {
    for await (const entry of entries) {
      assertEntry(entry);
      state.activeBody = entry.body instanceof Uint8Array ? null : entry.body;
      const pax = paxAttributes(entry);
      const headerPath = portableHeaderPath(entry.path, index);
      if (pax.length > 0) {
        const paxBody = encoder.encode(pax.join(""));
        const paxBodyBytes = paxBody.byteLength;
        yield tarHeader({
          path: `PaxHeaders/gsv-${String(index).padStart(8, "0")}`,
          size: paxBodyBytes,
          modifiedAt: entry.modifiedAt,
          mode: 0o600,
          type: "x",
        });
        yield paxBody;
        const paxPadding = padding(paxBodyBytes);
        if (paxPadding.byteLength > 0) yield paxPadding;
      }
      yield tarHeader({
        path: headerPath,
        size: entry.size <= TAR_MAX_OCTAL_SIZE ? entry.size : 0,
        modifiedAt: entry.modifiedAt,
        mode: entry.mode ?? 0o600,
        type: "0",
      });

      let written = 0;
      if (entry.body instanceof Uint8Array) {
        written = entry.body.byteLength;
        if (written > 0) yield entry.body;
      } else {
        state.activeReader = entry.body.getReader();
        try {
          while (true) {
            const next = await state.activeReader.read();
            if (next.done) break;
            const chunk = next.value;
            written += chunk.byteLength;
            if (written > entry.size) {
              throw new Error(`tar entry ${entry.path} exceeded its declared size`);
            }
            if (chunk.byteLength > 0) yield chunk;
          }
        } finally {
          state.activeReader.releaseLock();
          state.activeReader = null;
        }
      }
      if (state.cancelled) return;
      if (written !== entry.size) {
        throw new Error(
          `tar entry ${entry.path} wrote ${written} bytes; expected ${entry.size}`,
        );
      }
      const entryPadding = padding(entry.size);
      if (entryPadding.byteLength > 0) yield entryPadding;
      state.activeBody = null;
      index += 1;
    }
    yield new Uint8Array(TAR_BLOCK_BYTES * 2);
  } finally {
    await cancelActiveBody(state);
  }
}

async function cancelActiveBody(state: TarStreamState): Promise<void> {
  if (state.activeReader) {
    await state.activeReader.cancel("tar archive cancelled").catch(() => undefined);
  } else if (state.activeBody && !state.activeBody.locked) {
    await state.activeBody.cancel("tar archive cancelled").catch(() => undefined);
  }
}

function tarHeader(input: {
  path: string;
  size: number;
  modifiedAt?: number;
  mode: number;
  type: "0" | "x";
}): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  const split = splitUstarPath(input.path);
  writeBytes(header, 0, 100, encoder.encode(split.name));
  writeOctal(header, 100, 8, input.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, input.size);
  writeOctal(
    header,
    136,
    12,
    Math.floor((input.modifiedAt ?? Date.now()) / 1000),
  );
  header.fill(0x20, 148, 156);
  header[156] = input.type.charCodeAt(0);
  writeBytes(header, 257, 6, encoder.encode("ustar\0"));
  writeBytes(header, 263, 2, encoder.encode("00"));
  writeBytes(header, 265, 32, encoder.encode("gsv"));
  writeBytes(header, 297, 32, encoder.encode("gsv"));
  if (split.prefix) {
    writeBytes(header, 345, 155, encoder.encode(split.prefix));
  }
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeBytes(header, 148, 6, encoder.encode(checksumText));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function paxAttributes(entry: TarEntry): string[] {
  const attributes: string[] = [];
  if (!canRepresentUstarPath(entry.path)) {
    attributes.push(paxRecord("path", entry.path));
  }
  if (entry.size > TAR_MAX_OCTAL_SIZE) {
    attributes.push(paxRecord("size", String(entry.size)));
  }
  return attributes;
}

function paxRecord(key: string, value: string): string {
  const payload = `${key}=${value}\n`;
  const payloadBytes = encoder.encode(payload).byteLength;
  let length = payloadBytes + 3;
  while (true) {
    const next = payloadBytes + String(length).length + 1;
    if (next === length) return `${length} ${payload}`;
    length = next;
  }
}

function portableHeaderPath(path: string, index: number): string {
  return canRepresentUstarPath(path)
    ? path
    : `entries/gsv-${String(index).padStart(8, "0")}`;
}

function canRepresentUstarPath(path: string): boolean {
  try {
    splitUstarPath(path);
    return true;
  } catch {
    return false;
  }
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).byteLength <= 100) {
    return { name: path, prefix: "" };
  }
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      encoder.encode(prefix).byteLength <= 155
      && encoder.encode(name).byteLength <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new Error("tar path requires a PAX header");
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("tar numeric field is invalid");
  }
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) {
    throw new Error("tar numeric field exceeds its header width");
  }
  writeBytes(target, offset, length - 1, encoder.encode(text));
  target[offset + length - 1] = 0;
}

function writeBytes(
  target: Uint8Array,
  offset: number,
  maxLength: number,
  value: Uint8Array,
): void {
  if (value.byteLength > maxLength) {
    throw new Error("tar header value is too long");
  }
  target.set(value, offset);
}

function padding(size: number): Uint8Array {
  const bytes = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
  return new Uint8Array(bytes);
}

function assertEntry(entry: TarEntry): void {
  if (
    !entry.path
    || entry.path.startsWith("/")
    || entry.path.includes("\0")
    || entry.path.split("/").some((part) => part === "..")
  ) {
    throw new Error("tar entry path is unsafe");
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`tar entry ${entry.path} has an invalid size`);
  }
  if (
    entry.modifiedAt !== undefined
    && (!Number.isSafeInteger(entry.modifiedAt) || entry.modifiedAt < 0)
  ) {
    throw new Error(`tar entry ${entry.path} has an invalid modification time`);
  }
}
