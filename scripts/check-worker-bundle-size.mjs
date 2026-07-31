import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [bundlePath, maximumBytesRaw] = process.argv.slice(2);
const maximumBytes = Number(maximumBytesRaw);

if (!bundlePath || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
  throw new Error(
    "usage: node scripts/check-worker-bundle-size.mjs <bundle-path> <maximum-gzip-bytes>",
  );
}

const compressedBytes = gzipSync(readFileSync(bundlePath)).byteLength;
if (compressedBytes > maximumBytes) {
  throw new Error(
    `${bundlePath} is ${compressedBytes} gzip bytes, exceeding the ${maximumBytes}-byte Workers Free budget`,
  );
}

console.log(
  `${bundlePath}: ${compressedBytes} gzip bytes (${maximumBytes - compressedBytes} bytes of headroom)`,
);
