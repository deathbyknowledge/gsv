import { describe, expect, it } from "vitest";
import { siteStarterFiles } from "./starter";

describe("site starter", () => {
  it("creates a complete standalone React project with matching publication metadata", () => {
    const files = siteStarterFiles("my-new-site");
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore", "index.html", "package.json", "site.json", "src/App.css", "src/App.tsx", "src/main.tsx", "tsconfig.json", "vite.config.ts",
    ]);
    expect(JSON.parse(files["site.json"])).toEqual({
      slug: "my-new-site", title: "My New Site", description: "A place for your next idea.", routing: "spa", output: "dist",
    });
    expect(files["index.html"]).toContain("<title>My New Site</title>");
    expect(files["index.html"]).toContain('name="description" content="A place for your next idea."');
    expect(files["index.html"]).toContain('name="viewport"');
    expect(files["src/App.tsx"]).toContain("<h1>My New Site</h1>");
    expect(files["src/main.tsx"]).toContain('import App from "./App"');
    expect(files[".gitignore"]).toContain("node_modules/\ndist/");
  });

  it("pins direct dependencies and retains a release-specific or portable relative asset base", () => {
    const files = siteStarterFiles("demo");
    const manifest = JSON.parse(files["package.json"]);
    expect(manifest).toMatchObject({ name: "demo", private: true, type: "module", scripts: { build: "tsc --noEmit && vite build" } });
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["react", "react-dom"]);
    expect(manifest.dependencies.react).toBe(manifest.dependencies["react-dom"]);
    for (const version of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(files["vite.config.ts"]).toContain('base: process.env.GSV_SITE_BASE || "./"');
    expect(JSON.parse(files["tsconfig.json"])).toMatchObject({ compilerOptions: { strict: true, noEmit: true, jsx: "react-jsx" } });
  });

  it("rejects slugs that could escape the generated metadata or source", () => {
    for (const slug of ["", "../demo", "Demo", "a\"b", "<script>", "-demo", "demo-", "a".repeat(64)]) {
      expect(() => siteStarterFiles(slug)).toThrow();
    }
    expect(JSON.parse(siteStarterFiles("one--two")["site.json"]).title).toBe("One Two");
  });
});
