import type { ExportManagedInstallationInput } from "@humansandmachines/gsv/protocol";
import type { InstallationIdentity } from "../installation/identity";
import type { RipgitClient, RipgitRepoRef } from "../fs/ripgit/client";
import type { ProcessRecord } from "../kernel/processes";
import {
  captureSqlExportCatalog,
  readSqlExportPage,
  type SqlExportCatalog,
  type SqlExportPage,
  type SqlExportTable,
} from "./sql-export";
import {
  createTarStream,
  tarJsonEntry,
  tarTextEntry,
  type TarEntry,
} from "./tar";

const EXPORT_FORMAT_VERSION = 1;
const R2_LIST_PAGE_SIZE = 1_000;

type ManagedProcessExportSource = {
  getManagedExportCatalog(input: {
    installationId: string;
    processId: string;
  }): Promise<SqlExportCatalog>;
  getManagedExportTablePage(input: {
    installationId: string;
    processId: string;
    table: SqlExportTable;
    afterRowId: number | null;
  }): Promise<SqlExportPage>;
};

export type ManagedInstallationExportDependencies = {
  input: ExportManagedInstallationInput;
  identity: InstallationIdentity;
  kernelSql: SqlStorage;
  processes: ProcessRecord[];
  repositories: RipgitRepoRef[];
  storage: R2Bucket;
  ripgit: RipgitClient | null;
  process(processId: string): Promise<ManagedProcessExportSource>;
};

export function createManagedInstallationExport(
  dependencies: ManagedInstallationExportDependencies,
): Response {
  assertExportIdentity(dependencies.input, dependencies.identity);
  const exportedAt = Date.now();
  const kernelCatalog = captureSqlExportCatalog(dependencies.kernelSql);
  const processes = [...dependencies.processes].sort(compareProcesses);
  const repositories = [...dependencies.repositories].sort(compareRepositories);
  const body = createTarStream(exportEntries({
    ...dependencies,
    processes,
    repositories,
    kernelCatalog,
    exportedAt,
  }));
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="gsv-${dependencies.identity.handle}-export.tar"`,
      "content-security-policy": "sandbox",
      "content-type": "application/x-tar",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-gsv-export-format": String(EXPORT_FORMAT_VERSION),
    },
  });
}

async function* exportEntries(
  dependencies: ManagedInstallationExportDependencies & {
    kernelCatalog: SqlExportCatalog;
    exportedAt: number;
  },
): AsyncGenerator<TarEntry> {
  const root = "gsv-installation-export";
  const manifest = {
    format: "gsv-installation-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: dependencies.exportedAt,
    requestedAt: dependencies.input.requestedAt,
    installation: dependencies.identity,
    containsCredentialsAndPrivateData: true,
    consistency: "resource-level-capture",
    resources: {
      kernel: { catalog: "kernel/catalog.json" },
      processes: dependencies.processes.map((process) => ({
        processId: process.processId,
        ownerUid: process.ownerUid,
        record: `processes/${encodePathIdentity(process.processId)}/record.json`,
      })),
      repositories: dependencies.repositories.map((repository, index) => ({
        owner: repository.owner,
        repo: repository.repo,
        bundle: `repositories/${String(index).padStart(8, "0")}.bundle`,
      })),
      storage: {
        metadataDirectory: "storage/metadata",
        objectDirectory: "storage/objects",
      },
    },
    completionRecord: "completion.json",
  };
  yield tarJsonEntry(`${root}/manifest.json`, manifest, dependencies.exportedAt);
  yield tarTextEntry(
    `${root}/README.txt`,
    exportReadme(),
    dependencies.exportedAt,
  );

  const kernelRows = yield* sqlSnapshotEntries({
    root,
    prefix: "kernel",
    catalog: dependencies.kernelCatalog,
    readPage: (table, afterRowId) => Promise.resolve(readSqlExportPage(
      dependencies.kernelSql,
      table,
      afterRowId,
    )),
    modifiedAt: dependencies.exportedAt,
  });

  let processRows = 0;
  for (const record of dependencies.processes) {
    const encodedProcessId = encodePathIdentity(record.processId);
    const prefix = `processes/${encodedProcessId}`;
    yield tarJsonEntry(
      `${root}/${prefix}/record.json`,
      record,
      dependencies.exportedAt,
    );
    const process = await dependencies.process(record.processId);
    const catalog = await process.getManagedExportCatalog({
      installationId: dependencies.identity.installationId,
      processId: record.processId,
    });
    processRows += yield* sqlSnapshotEntries({
      root,
      prefix,
      catalog,
      readPage: (table, afterRowId) => process.getManagedExportTablePage({
        installationId: dependencies.identity.installationId,
        processId: record.processId,
        table,
        afterRowId,
      }),
      modifiedAt: dependencies.exportedAt,
    });
  }

  if (dependencies.repositories.length > 0 && !dependencies.ripgit) {
    throw new Error("RIPGIT binding is required for managed export");
  }
  let repositoryBytes = 0;
  for (const [index, repository] of dependencies.repositories.entries()) {
    const bundle = await dependencies.ripgit!.exportBundle(repository, "root");
    repositoryBytes += bundle.size;
    yield {
      path: `${root}/repositories/${String(index).padStart(8, "0")}.bundle`,
      size: bundle.size,
      body: bundle.body,
      modifiedAt: dependencies.exportedAt,
    };
  }

  let storageObjects = 0;
  let storageBytes = 0;
  let cursor: string | undefined;
  do {
    const listing = await dependencies.storage.list({
      limit: R2_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const listed of listing.objects) {
      const object = await dependencies.storage.get(listed.key);
      if (!object) {
        throw new Error(`storage object disappeared during export: ${listed.key}`);
      }
      if (
        object.version !== listed.version
        || object.size !== listed.size
        || object.etag !== listed.etag
      ) {
        await object.body.cancel("storage object changed during export")
          .catch(() => undefined);
        throw new Error(`storage object changed during export: ${listed.key}`);
      }
      const encodedKey = encodePathIdentity(object.key);
      const metadata = storageObjectMetadata(object, encodedKey);
      yield tarJsonEntry(
        `${root}/storage/metadata/${encodedKey}.json`,
        metadata,
        object.uploaded.getTime(),
      );
      yield {
        path: `${root}/storage/objects/${encodedKey}`,
        size: object.size,
        body: object.body as ReadableStream<Uint8Array>,
        modifiedAt: object.uploaded.getTime(),
      };
      storageObjects += 1;
      storageBytes += object.size;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  yield tarJsonEntry(`${root}/completion.json`, {
    format: "gsv-installation-export-completion",
    version: EXPORT_FORMAT_VERSION,
    completedAt: Date.now(),
    installationId: dependencies.identity.installationId,
    resources: {
      kernel: {
        tables: dependencies.kernelCatalog.tables.length,
        rows: kernelRows,
      },
      processes: {
        count: dependencies.processes.length,
        rows: processRows,
      },
      repositories: {
        count: dependencies.repositories.length,
        bytes: repositoryBytes,
      },
      storage: {
        objects: storageObjects,
        bytes: storageBytes,
      },
    },
  }, dependencies.exportedAt);
}

async function* sqlSnapshotEntries(input: {
  root: string;
  prefix: string;
  catalog: SqlExportCatalog;
  readPage(
    table: SqlExportTable,
    afterRowId: number | null,
  ): Promise<SqlExportPage>;
  modifiedAt: number;
}): AsyncGenerator<TarEntry, number> {
  assertCatalog(input.catalog);
  yield tarJsonEntry(
    `${input.root}/${input.prefix}/catalog.json`,
    input.catalog,
    input.modifiedAt,
  );
  let totalRows = 0;
  for (const table of input.catalog.tables) {
    let afterRowId: number | null = null;
    let pageIndex = 0;
    let tableRows = 0;
    while (table.throughRowId !== null) {
      const page = await input.readPage(table, afterRowId);
      assertPage(page, table, afterRowId);
      tableRows += page.rows.length;
      totalRows += page.rows.length;
      if (page.rows.length > 0) {
        yield tarJsonEntry(
          `${input.root}/${input.prefix}/tables/${table.name}/${String(pageIndex).padStart(8, "0")}.json`,
          page,
          input.modifiedAt,
        );
        pageIndex += 1;
      }
      if (page.complete) break;
      if (page.nextRowId === null || page.nextRowId === afterRowId) {
        throw new Error(`SQL export cursor did not advance for ${table.name}`);
      }
      afterRowId = page.nextRowId;
    }
    if (tableRows !== table.rowCount) {
      throw new Error(
        `SQL export table ${table.name} changed during snapshot: expected ${table.rowCount} rows, read ${tableRows}`,
      );
    }
  }
  return totalRows;
}

function assertCatalog(catalog: SqlExportCatalog): void {
  if (catalog.format !== "gsv-sql-snapshot" || catalog.version !== 1) {
    throw new Error("SQL export catalog is incompatible");
  }
  const names = new Set<string>();
  for (const table of catalog.tables) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)
      || names.has(table.name)
      || (table.restoreMode !== "create" && table.restoreMode !== "sqlite-sequence")
      || ((table.restoreMode === "sqlite-sequence") !== (table.name === "sqlite_sequence"))
      || !Number.isSafeInteger(table.rowCount)
      || table.rowCount < 0
    ) {
      throw new Error("SQL export catalog is invalid");
    }
    names.add(table.name);
  }
  const schemaObjects = new Set<string>();
  for (const object of catalog.schemaObjects) {
    const key = `${object.type}:${object.name}`;
    if (
      (object.type !== "index" && object.type !== "trigger" && object.type !== "view")
      || !object.name
      || !object.tableName
      || !object.createSql
      || schemaObjects.has(key)
    ) {
      throw new Error("SQL export schema object is invalid");
    }
    schemaObjects.add(key);
  }
}

function assertPage(
  page: SqlExportPage,
  table: SqlExportTable,
  afterRowId: number | null,
): void {
  if (
    page.table !== table.name
    || page.afterRowId !== afterRowId
    || page.throughRowId !== table.throughRowId
    || page.columns.length !== table.columns.length + 1
    || page.columns[0] !== "rowid"
    || page.columns.slice(1).some((column, index) => column !== table.columns[index])
    || page.rows.some((row) => row.length !== page.columns.length)
  ) {
    throw new Error(`SQL export page for ${table.name} is invalid`);
  }
}

function storageObjectMetadata(object: R2Object, archiveKey: string): unknown {
  return {
    key: object.key,
    archiveKey,
    version: object.version,
    size: object.size,
    etag: object.etag,
    httpEtag: object.httpEtag,
    checksums: object.checksums.toJSON(),
    uploadedAt: object.uploaded.getTime(),
    httpMetadata: object.httpMetadata ?? null,
    customMetadata: object.customMetadata ?? null,
    storageClass: object.storageClass,
    ssecKeyMd5: object.ssecKeyMd5 ?? null,
  };
}

function assertExportIdentity(
  input: ExportManagedInstallationInput,
  identity: InstallationIdentity,
): void {
  if (input.installationId !== identity.installationId) {
    throw new Error("managed export installation does not match Kernel");
  }
  if (!Number.isSafeInteger(input.requestedAt) || input.requestedAt < 0) {
    throw new Error("managed export request timestamp is invalid");
  }
}

function encodePathIdentity(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function compareProcesses(left: ProcessRecord, right: ProcessRecord): number {
  return left.processId < right.processId ? -1 : left.processId > right.processId ? 1 : 0;
}

function compareRepositories(left: RipgitRepoRef, right: RipgitRepoRef): number {
  return left.owner < right.owner
    ? -1
    : left.owner > right.owner
      ? 1
      : left.repo < right.repo
        ? -1
        : left.repo > right.repo
          ? 1
          : 0;
}

function exportReadme(): string {
  return [
    "GSV installation export",
    "",
    "This archive contains private files, process histories, configuration,",
    "credentials, repository history, and installation runtime state. Store it",
    "with the same care as a password-manager or full-device backup.",
    "",
    "manifest.json defines the versioned format and resource set. Kernel and",
    "Process SQLite state is represented as a complete schema catalog plus",
    "ordered JSON pages, including AUTOINCREMENT sequence state.",
    "Each repository is a standard self-contained Git bundle. R2 object metadata",
    "maps each original logical key to its encoded file under storage/objects.",
    "",
    "A valid complete archive ends with completion.json. If that record is absent,",
    "the stream was interrupted or a resource changed incompatibly during export.",
    "",
  ].join("\n");
}
