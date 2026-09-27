import { build } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

const entry = fileURLToPath(new URL("./prompt-preview.ts", import.meta.url));
const require = createRequire(import.meta.url);

export async function loadPromptPreview(account, draft) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
    loader: { ".md": "text" },
    plugins: draft ? [{
      name: "unsaved-markdown",
      setup(builder) {
        builder.onLoad({ filter: /\.md$/ }, ({ path }) => path === resolve(draft.absolutePath)
          ? { contents: draft.content, loader: "text" } : undefined);
      },
    }] : [],
  });
  // Evaluate trusted repository code afresh so disk edits and drafts are visible without
  // retaining an ESM module for every keystroke. Markdown is bundled as string data.
  const module = { exports: {} };
  compileFunction(result.outputFiles[0].text, ["module", "exports", "require"], { filename: entry })(
    module, module.exports, require,
  );
  return module.exports.createPromptPreview(account);
}
