#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function fail(message) {
  throw new Error(message);
}

function collectFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = resolve(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function header(size) {
  return Buffer.alloc(size);
}

function u16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function u32(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function createZip(rootDir, zipPath) {
  const root = resolve(rootDir);
  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const filePath of collectFiles(root)) {
    const stats = statSync(filePath);
    const data = readFileSync(filePath);
    const name = relative(root, filePath).split(sep).join("/");
    const nameBytes = Buffer.from(name, "utf8");
    const { date, time } = dosDateTime(stats.mtime);
    const crc = crc32(data);

    if (data.length > 0xffffffff || offset > 0xffffffff) {
      fail("Zip64 is not supported by this packaging script");
    }

    const localHeaderOffset = offset;
    const localHeader = header(30);
    u32(localHeader, 0, 0x04034b50);
    u16(localHeader, 4, 20);
    u16(localHeader, 6, 0);
    u16(localHeader, 8, 0);
    u16(localHeader, 10, time);
    u16(localHeader, 12, date);
    u32(localHeader, 14, crc);
    u32(localHeader, 18, data.length);
    u32(localHeader, 22, data.length);
    u16(localHeader, 26, nameBytes.length);
    u16(localHeader, 28, 0);

    chunks.push(localHeader, nameBytes, data);
    offset += localHeader.length + nameBytes.length + data.length;
    entries.push({ nameBytes, date, time, crc, size: data.length, localHeaderOffset });
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryChunks = [];
  for (const entry of entries) {
    const centralHeader = header(46);
    u32(centralHeader, 0, 0x02014b50);
    u16(centralHeader, 4, 20);
    u16(centralHeader, 6, 20);
    u16(centralHeader, 8, 0);
    u16(centralHeader, 10, 0);
    u16(centralHeader, 12, entry.time);
    u16(centralHeader, 14, entry.date);
    u32(centralHeader, 16, entry.crc);
    u32(centralHeader, 20, entry.size);
    u32(centralHeader, 24, entry.size);
    u16(centralHeader, 28, entry.nameBytes.length);
    u16(centralHeader, 30, 0);
    u16(centralHeader, 32, 0);
    u16(centralHeader, 34, 0);
    u16(centralHeader, 36, 0);
    u32(centralHeader, 38, 0);
    u32(centralHeader, 42, entry.localHeaderOffset);
    centralDirectoryChunks.push(centralHeader, entry.nameBytes);
    offset += centralHeader.length + entry.nameBytes.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  const endHeader = header(22);
  u32(endHeader, 0, 0x06054b50);
  u16(endHeader, 4, 0);
  u16(endHeader, 6, 0);
  u16(endHeader, 8, entries.length);
  u16(endHeader, 10, entries.length);
  u32(endHeader, 12, centralDirectorySize);
  u32(endHeader, 16, centralDirectoryOffset);
  u16(endHeader, 20, 0);

  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, Buffer.concat([...chunks, ...centralDirectoryChunks, endHeader]));
}

try {
  const [rootDir, zipPath] = process.argv.slice(2);
  if (!rootDir || !zipPath) {
    fail("Usage: node scripts/zip-directory.mjs <directory> <zip-path>");
  }
  createZip(rootDir, zipPath);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
