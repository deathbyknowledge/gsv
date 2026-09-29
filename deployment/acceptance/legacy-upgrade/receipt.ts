import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LEGACY_PRIVATE_REVISION, LEGACY_PUBLIC_REVISION, type UpgradeFixture } from "./plan.ts";

const receiptSchema = z.object({
  phase: z.enum(["legacy", "current"]),
  privateRevision: z.string(), publicRevision: z.string(),
  hashes: z.record(z.string().regex(/^(accounts|inference|gateway|ripgit|web|migrations)\/[a-zA-Z0-9_./@-]+$/), z.string().regex(/^[a-f0-9]{64}$/)),
});

/** A deploy or fixture mutation must use the exact complete output that was built. */
export function assertUpgradeBuildReceipt(input: UpgradeFixture, phase: "legacy" | "current"): void {
  const directory = join(input.artifactsDirectory, phase);
  const receipt = receiptSchema.parse(JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")));
  if (receipt.phase !== phase || receipt.privateRevision !== (phase === "legacy" ? LEGACY_PRIVATE_REVISION : input.currentPrivateRevision)
    || receipt.publicRevision !== (phase === "legacy" ? LEGACY_PUBLIC_REVISION : input.currentPublicRevision)) {
    throw new Error("Build receipt does not match the reviewed source pins");
  }
  const actual = new Set<string>();
  function visit(relative: string): void {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else {
        if (!entry.isFile()) throw new Error("Build output contains a non-file entry");
        actual.add(name);
        const hash = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
        if (receipt.hashes[name] !== hash) throw new Error("Build output differs from its receipt");
      }
    }
  }
  for (const name of ["accounts", "inference", "gateway", "ripgit", "web", "migrations"]) visit(name);
  if (actual.size !== Object.keys(receipt.hashes).length || actual.size === 0) throw new Error("Build receipt contains missing or unexpected output");
}
