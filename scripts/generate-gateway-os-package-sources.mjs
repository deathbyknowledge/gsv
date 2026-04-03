import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packagesRoot = path.join(root, "gateway-os", "packages");
const outputPath = path.join(root, "gateway-os", "src", "kernel", "generated", "builtin-package-sources.ts");

async function listFiles(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        continue;
      }
      files.push(...await listFiles(abs, rel));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const content = await fs.readFile(abs, "utf8");
    files.push({ path: rel, content });
  }
  return files;
}

async function main() {
  const packageNames = (await fs.readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const trees = [];
  for (const packageName of packageNames) {
    const packageDir = path.join(packagesRoot, packageName);
    trees.push({
      packageName,
      subdir: `packages/${packageName}`,
      files: await listFiles(packageDir),
    });
  }

  const source = [
    "export type BuiltinPackageSourceFile = {",
    "  path: string;",
    "  content: string;",
    "};",
    "",
    "export type BuiltinPackageSourceTree = {",
    "  packageName: string;",
    "  subdir: string;",
    "  files: BuiltinPackageSourceFile[];",
    "};",
    "",
    "export const BUILTIN_PACKAGE_SOURCE_TREES: readonly BuiltinPackageSourceTree[] = ",
    `${JSON.stringify(trees, null, 2)} as const;`,
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, source, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
