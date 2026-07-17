import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "../../packages/portable-archive/src/canonical-json.ts";
import { RipgitSnapshotStreamValidator } from "../../packages/portable-archive/src/ripgit.ts";
import { ObjectSemanticDigestV1 } from "../../packages/portable-archive/src/semantic.ts";

const TOKEN = "managed-test-token";
const MANAGED_PREFIX = "https://ripgit.test/__gsv/managed/v1/ripgit";
const STREAM_MEDIA_TYPE = "application/vnd.gsv.data-frame-stream.v1";
const MAGIC = new Uint8Array([0x47, 0x53, 0x56, 0x44, 0x46, 0, 1, 0x0a]);
const TERMINATOR = new Uint8Array(18);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

describe("managed framed repository portability", () => {
  let mf;
  let providerId;
  let fenceEpoch;

  beforeAll(async () => {
    mf = createMiniflare();

    const initialized = await mf.dispatchFetch(
      "https://ripgit.test/alice/memory/refs",
    );
    expect(initialized.status).toBe(200);
    const written = await mf.dispatchFetch(
      "https://ripgit.test/alice/memory/hyperspace/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: "Managed Test",
          email: "managed@example.test",
          message: "seed repository",
          ops: [{
            type: "put",
            path: "memory.txt",
            contentBytes: Array.from(encoder.encode("portable memory\n")),
          }],
        }),
      },
    );
    expect(written.status).toBe(200);
    await expect(written.json()).resolves.toMatchObject({ ok: true });

    const inventory = await managedJson(mf, "inventory", {
      cursor: null,
      limit: 100,
    });
    providerId = inventory.repositories[0].identity.providerId;
    const paused = await managedJson(mf, "pause", { cursor: null, limit: 100 });
    expect(paused.gate.status).toBe("paused");
    expect(paused.pendingRepositories).toBe(0);
    fenceEpoch = paused.gate.epoch;
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  it("streams repository rows and restores them idempotently", async () => {
    const objectId = "repository:alice/memory";
    const snapshot = await mf.dispatchFetch(`${MANAGED_PREFIX}/objects/snapshot`, {
      method: "POST",
      headers: managedHeaders("application/json"),
      body: JSON.stringify({
        component: "ripgit",
        kind: "repository",
        providerId,
        logicalName: "alice/memory",
        objectId,
        fenceEpoch,
      }),
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("content-type")).toBe(STREAM_MEDIA_TYPE);
    const records = decodeStream(new Uint8Array(await snapshot.arrayBuffer()));
    expect(records.length).toBeGreaterThan(1);
    expect(records[0]).toMatchObject({
      kind: "do.sqlite.schema",
      objectId,
      part: 0,
      bodyMediaType: "application/vnd.gsv.ripgit-snapshot-manifest+json",
    });
    const snapshotManifest = JSON.parse(decoder.decode(records[0].body));
    expect(snapshotManifest.body.identity).toEqual({
      owner: "alice",
      repo: "memory",
    });
    expect(snapshotManifest.body.sourceEpoch).toBe(fenceEpoch);
    expect(records.slice(1).every((record) => (
      record.kind === "do.sqlite.rows"
      && record.bodyMediaType === "application/vnd.gsv.ripgit-snapshot-page+json"
    ))).toBe(true);
    const publicValidator = new RipgitSnapshotStreamValidator({
      objectId,
      logicalName: "alice/memory",
    });
    for (const record of records) {
      await publicValidator.observe({ ...record, bodyEncoding: "identity" });
    }
    const publicSnapshot = publicValidator.finish();
    expect(publicSnapshot.rowCount).toBeGreaterThan(0);
    expect(publicSnapshot.sqlite.tables.map((table) => table.name))
      .toEqual([...publicSnapshot.sqlite.tables.map((table) => table.name)].sort());

    const target = createMiniflare();
    const initialized = await target.dispatchFetch(
      "https://ripgit.test/alice/memory/refs",
    );
    expect(initialized.status).toBe(200);
    const targetInventory = await managedJson(target, "inventory", {
      cursor: null,
      limit: 100,
    });
    const targetProviderId = targetInventory.repositories[0].identity.providerId;
    const targetPause = await managedJson(target, "pause", {
      cursor: null,
      limit: 100,
    });
    expect(targetPause.gate.status).toBe("paused");
    expect(targetPause.pendingRepositories).toBe(0);

    const semantic = await ObjectSemanticDigestV1.create(objectId);
    let bodyBytes = 0;
    for (const record of records) {
      await semantic.append({
        kind: record.kind,
        part: record.part,
        bodyMediaType: record.bodyMediaType,
        body: record.body,
      });
      bodyBytes += record.body.byteLength;
    }
    const control = {
      component: "ripgit",
      kind: "repository",
      logicalName: "alice/memory",
      objectId,
      restoreId: "repository-restore",
      fenceEpoch: targetPause.gate.epoch,
      frameCount: records.length.toString(),
      bodyBytes: bodyBytes.toString(),
      semanticSha256: semantic.digestBase64Url(),
    };
    const restoreBody = encodeStream([{
      kind: "gsv.restore.control",
      objectId,
      part: 0,
      bodyMediaType: "application/json",
      body: canonicalJsonBytes(control),
    }, ...records]);

    try {
      const applied = await restore(target, restoreBody);
      expect(applied.status).toBe(200);
      await expect(applied.json()).resolves.toEqual({
        status: "applied",
        providerId: targetProviderId,
        frameCount: control.frameCount,
        bodyBytes: control.bodyBytes,
        semanticSha256: control.semanticSha256,
      });

      const replayed = await restore(target, restoreBody);
      expect(replayed.status).toBe(200);
      await expect(replayed.json()).resolves.toEqual({
        status: "replayed",
        providerId: targetProviderId,
        frameCount: control.frameCount,
        bodyBytes: control.bodyBytes,
        semanticSha256: control.semanticSha256,
      });

      const restored = await target.dispatchFetch(
        "https://ripgit.test/alice/memory/hyperspace/read?ref=main&path=memory.txt",
      );
      expect(restored.status).toBe(200);
      await expect(restored.text()).resolves.toBe("portable memory\n");
    } finally {
      await target.dispose();
    }
  });

  it("rejects registry and admission infrastructure from the data plane", async () => {
    for (const kind of ["repository_registry", "adapter_admission"]) {
      const response = await mf.dispatchFetch(`${MANAGED_PREFIX}/objects/snapshot`, {
        method: "POST",
        headers: managedHeaders("application/json"),
        body: JSON.stringify({
          component: "ripgit",
          kind,
          providerId,
          logicalName: "alice/memory",
          objectId: "infrastructure",
          fenceEpoch,
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_managed_object_kind",
      });
    }
  });

  it("erases repositories page by page and keeps the fleet irreversibly fenced", async () => {
    const target = createMiniflare();
    try {
      for (const repo of ["one", "two", "three"]) {
        const initialized = await target.dispatchFetch(
          `https://ripgit.test/alice/${repo}/refs`,
        );
        expect(initialized.status).toBe(200);
        const written = await target.dispatchFetch(
          `https://ripgit.test/alice/${repo}/hyperspace/apply`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              author: "Erase Test",
              email: "erase@example.test",
              message: `seed ${repo}`,
              ops: [{
                type: "put",
                path: `${repo}.txt`,
                contentBytes: Array.from(encoder.encode(`erase ${repo}\n`)),
              }],
            }),
          },
        );
        expect(written.status).toBe(200);
      }

      const before = await managedJson(target, "inventory", {
        cursor: null,
        limit: 100,
      });
      expect(before.repositories).toHaveLength(3);
      const providerIds = before.repositories.map((record) => record.identity.providerId);

      let cursor = null;
      let pages = 0;
      for (;;) {
        const batch = await managedJson(target, "erase", { cursor, limit: 1 });
        pages += 1;
        expect(batch.gate.status).toBe("paused");
        expect(batch.gate.epoch).toBe(batch.erasure.epoch);
        if (batch.erasure.status === "erased") {
          expect(batch.nextCursor).toBeNull();
          expect(batch.remainingRepositories).toBe(0);
          break;
        }
        expect(batch.erasure.status).toBe("erasing");
        expect(batch.erasedRepositories).toHaveLength(1);
        expect(batch.nextCursor).toMatch(/^[0-9a-f]{64}$/);
        cursor = batch.nextCursor;
      }
      expect(pages).toBe(3);

      const terminal = await managedJson(target, "inventory", {
        cursor: null,
        limit: 1,
      });
      expect(terminal).toMatchObject({
        erasure: { status: "erased" },
        repositories: [],
        nextCursor: null,
      });

      const replay = await managedJson(target, "erase", { cursor: null, limit: 1 });
      expect(replay).toMatchObject({
        erasure: { status: "erased" },
        erasedRepositories: [],
        nextCursor: null,
        remainingRepositories: 0,
      });

      const described = await managedJson(target, "objects/describe", {
        kind: "repository",
        providerIds,
      });
      expect(described.objects).toHaveLength(3);
      expect(described.objects.every((descriptor) => (
        descriptor.classification === "erased"
        && descriptor.lifecycle.status === "erased"
      ))).toBe(true);

      const resume = await target.dispatchFetch(`${MANAGED_PREFIX}/resume`, {
        method: "POST",
        headers: managedHeaders("application/json"),
        body: JSON.stringify({ cursor: null, limit: 1 }),
      });
      expect(resume.status).toBe(410);
      await expect(resume.json()).resolves.toMatchObject({
        error: "managed_repository_registry_erased",
      });

      const resurrect = await target.dispatchFetch(
        "https://ripgit.test/alice/one/refs",
      );
      expect(resurrect.status).toBe(410);
      await expect(resurrect.json()).resolves.toMatchObject({
        error: "managed_repository_registry_erased",
      });
    } finally {
      await target.dispose();
    }
  });

});

function createMiniflare() {
  return new Miniflare({
    rootPath: ".",
    scriptPath: "build/index.js",
    modules: true,
    modulesRules: [{
      type: "CompiledWasm",
      include: ["**/*.wasm"],
      fallthrough: true,
    }],
    compatibilityDate: "2026-03-18",
    bindings: {
      GSV_MANAGED_ADMIN_TOKEN_HASH: createHash("sha256")
        .update(TOKEN)
        .digest("hex"),
    },
    durableObjects: {
      REPOSITORY: { className: "Repository", useSQLite: true },
      MANAGED_REPOSITORY_REGISTRY: {
        className: "ManagedRepositoryRegistry",
        useSQLite: true,
      },
    },
    durableObjectsPersist: false,
  });
}

async function managedJson(runtime, path, body) {
  const response = await runtime.dispatchFetch(`${MANAGED_PREFIX}/${path}`, {
    method: "POST",
    headers: managedHeaders("application/json"),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}

function restore(runtime, body) {
  return runtime.dispatchFetch(`${MANAGED_PREFIX}/objects/restore`, {
    method: "POST",
    headers: managedHeaders(STREAM_MEDIA_TYPE),
    body,
  });
}

function managedHeaders(contentType) {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": contentType,
  };
}

function decodeStream(bytes) {
  expect(Array.from(bytes.subarray(0, MAGIC.byteLength))).toEqual(Array.from(MAGIC));
  const records = [];
  let offset = MAGIC.byteLength;
  while (true) {
    const prefix = bytes.subarray(offset, offset + 18);
    expect(prefix.byteLength).toBe(18);
    offset += 18;
    if (prefix.every((byte) => byte === 0)) break;
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    const kindBytes = view.getUint16(0, false);
    const objectIdBytes = view.getUint16(2, false);
    const mediaTypeBytes = view.getUint16(4, false);
    const part = view.getUint32(6, false);
    const bodyBytes = Number(view.getBigUint64(10, false));
    const kind = decoder.decode(bytes.subarray(offset, offset + kindBytes));
    offset += kindBytes;
    const objectId = decoder.decode(bytes.subarray(offset, offset + objectIdBytes));
    offset += objectIdBytes;
    const bodyMediaType = decoder.decode(
      bytes.subarray(offset, offset + mediaTypeBytes),
    );
    offset += mediaTypeBytes;
    const body = bytes.slice(offset, offset + bodyBytes);
    offset += bodyBytes;
    records.push({ kind, objectId, bodyMediaType, part, body });
  }
  expect(offset).toBe(bytes.byteLength);
  return records;
}

function encodeStream(records) {
  return concat([MAGIC, ...records.flatMap(encodeRecord), TERMINATOR]);
}

function encodeRecord(record) {
  const kind = encoder.encode(record.kind);
  const objectId = encoder.encode(record.objectId);
  const mediaType = encoder.encode(record.bodyMediaType);
  const prefix = new Uint8Array(18);
  const view = new DataView(prefix.buffer);
  view.setUint16(0, kind.byteLength, false);
  view.setUint16(2, objectId.byteLength, false);
  view.setUint16(4, mediaType.byteLength, false);
  view.setUint32(6, record.part, false);
  view.setBigUint64(10, BigInt(record.body.byteLength), false);
  return [prefix, kind, objectId, mediaType, record.body];
}

function concat(parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
