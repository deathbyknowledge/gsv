# package sdk static extraction

This document defines the v1 static extraction contract for `definePackage(...)`.

Goal:

- Let ripgit package tooling understand package metadata and entrypoints without executing package code.

This is a build-time and analysis-time contract.

It is intentionally stricter than general TypeScript authoring.

## scope

Static extraction is responsible for:

- locating the package module
- finding the package definition
- extracting package metadata
- extracting command names
- detecting presence of app and tasks
- identifying handler references
- validating that the definition is statically analyzable

Static extraction is not responsible for:

- executing handlers
- evaluating arbitrary runtime code
- proving semantic correctness of package logic
- replacing runtime authorization checks

## source of truth

The package definition entry file is:

- `src/package.ts`

v1 rule:

- this path is fixed
- ripgit package tooling reads this file directly

Future override mechanisms can be added later if needed, but they are not part of v1.

## required import

The package module must import `definePackage` from `@gsv/package-worker`.

Allowed:

```ts
import { definePackage } from "@gsv/package-worker";
```

Rejected:

```ts
import { definePackage as dp } from "@gsv/package-worker";
```

```ts
import * as pkg from "@gsv/package-worker";
pkg.definePackage(...)
```

Reason:

- keep the first extraction pass simple and unambiguous

## allowed default export forms

v1 allows exactly two forms.

### form 1: direct default export

```ts
export default definePackage({
  ...
});
```

### form 2: local constant then default export

```ts
const pkg = definePackage({
  ...
});

export default pkg;
```

Additional rules:

- the constant must be defined in the same module
- the constant initializer must be the `definePackage(...)` call directly
- there may be only one package definition per module

Everything else is rejected.

Rejected examples:

```ts
const config = getConfigSomehow();
export default definePackage(config);
```

```ts
export default makePackage();
```

```ts
const pkg = condition ? definePackage({...}) : definePackage({...});
export default pkg;
```

## allowed package object shape

The first argument to `definePackage(...)` must be an object literal.

Allowed top-level keys:

- `meta`
- `setup`
- `commands`
- `app`
- `tasks`

Unknown top-level keys are rejected in v1.

Reason:

- keep the contract explicit
- prevent silent metadata drift

## extraction targets

The extractor produces this normalized shape:

```ts
type ExtractedPackageDefinition = {
  meta: ExtractedPackageMeta;
  setup: ExtractedHandlerReference | null;
  commands: ExtractedCommandDefinition[];
  app: ExtractedAppDefinition | null;
  tasks: ExtractedTaskDefinition[];
};

type ExtractedPackageMeta = {
  displayName: string;
  description: string | null;
  icon: string | null;
  window: {
    width: number | null;
    height: number | null;
    minWidth: number | null;
    minHeight: number | null;
  } | null;
  capabilities: {
    kernel: string[];
    outbound: string[];
  };
};

type ExtractedCommandDefinition = {
  name: string;
  handler: ExtractedHandlerReference;
};

type ExtractedTaskDefinition = {
  name: string;
  handler: ExtractedHandlerReference;
};

type ExtractedAppDefinition = {
  handler: ExtractedHandlerReference;
};

type ExtractedHandlerReference = {
  kind: "inline-function" | "local-identifier";
  exportName: "default";
  path: "src/package.ts";
  localName: string | null;
};
```

This is an analysis artifact, not the runtime manifest.

## metadata extraction rules

### `meta` is required

The package object must include a `meta` object literal.

### allowed `meta` keys

- `displayName`
- `description`
- `icon`
- `window`
- `capabilities`

Unknown keys are rejected in v1.

### `displayName`

Required.

Must be a string literal.

Allowed:

```ts
displayName: "RSS Reader"
```

Rejected:

```ts
displayName: NAME
```

### `description`

Optional.

Must be a string literal if present.

### `icon`

Optional.

Must be a string literal package-relative path if present.

v1 rules:

- must start with `./`
- must not escape the package root

Example:

```ts
icon: "./ui/icon.svg"
```

### `window`

Optional.

Must be an object literal if present.

Allowed keys:

- `width`
- `height`
- `minWidth`
- `minHeight`

All values must be numeric literals.

### `capabilities`

Optional.

Must be an object literal if present.

Allowed keys:

- `kernel`
- `outbound`

Both values must be arrays of string literals.

Example:

```ts
capabilities: {
  kernel: ["fs.read", "fs.write"],
  outbound: ["https://*"],
}
```

Rejected:

```ts
capabilities: {
  kernel: SOME_LIST,
}
```

## handler extraction rules

Handlers may be expressed in two ways.

### inline function

Allowed:

```ts
setup: async (ctx) => { ... }
```

```ts
app: {
  fetch: async (request, ctx) => { ... }
}
```

### local identifier

Allowed:

```ts
const refreshFeeds = async (ctx) => { ... };

tasks: {
  refreshFeeds,
}
```

```ts
async function doctor(ctx) { ... }

commands: {
  doctor,
}
```

v1 requirement:

- referenced identifiers must be declared in the same module

The extractor does not inline or analyze the full body at this stage.

It only records the handler reference and validates the declaration shape exists.

## `setup` rules

`setup` is optional.

If present, it must be:

- an inline function expression or arrow function
- or a same-module identifier referencing a function

## `commands` rules

`commands` is optional.

If present:

- it must be an object literal
- each key must be a string literal or identifier-compatible static key
- each value must be an inline function or same-module identifier

Allowed:

```ts
commands: {
  doctor: async (ctx) => { ... },
  "rss-list": listFeeds,
}
```

Rejected:

```ts
commands: commandTable
```

```ts
commands: {
  [someName]: async (ctx) => { ... },
}
```

## `app` rules

`app` is optional.

If present:

- it must be an object literal
- the only allowed key in v1 is `fetch`
- `fetch` must be an inline function or same-module identifier

Allowed:

```ts
app: {
  fetch: appFetch,
}
```

Rejected:

```ts
app: appDefinition
```

```ts
app: {
  fetch,
  onSignal,
}
```

Reason:

- async app routing hooks are not part of the v1 runtime contract

## `tasks` rules

`tasks` is optional.

If present:

- it must be an object literal
- each key must be a static task name
- each value must be an inline function or same-module identifier

Allowed:

```ts
tasks: {
  refreshFeeds: async (ctx) => { ... },
  reindex: reindexTask,
}
```

Rejected:

```ts
tasks: makeTasks()
```

## allowed expressions inside extracted metadata

The extractor only evaluates these literal forms inside metadata:

- string literals
- numeric literals
- boolean literals if later needed
- object literals
- array literals
- `null`

The extractor does not evaluate:

- identifiers
- template expressions
- function calls
- binary expressions
- spread
- conditional expressions
- environment reads

Rejected example:

```ts
meta: {
  displayName: `RSS ${VERSION}`,
}
```

Reason:

- static extraction must be deterministic without partial evaluation

## path normalization rules

Paths extracted from metadata must:

- be package-relative
- start with `./`
- not contain `..` segments escaping the package root

The extractor normalizes separators to `/`.

## package.json interplay

Static extraction also reads `package.json`.

It extracts:

- `name`
- `version`
- `type`
- dependency sections

Static extraction merges the two sources conceptually like this:

- `package.json` supplies npm/package identity
- `definePackage(...)` supplies runtime/package behavior

Conflicts are not expected because the owned fields are separate.

## diagnostics

The extractor must return structured diagnostics.

Minimum diagnostic shape:

```ts
type PackageExtractionDiagnostic = {
  severity: "error" | "warning";
  message: string;
  path: string;
  line: number;
  column: number;
};
```

Examples:

- missing `meta.displayName`
- unsupported `definePackage` export form
- computed command key
- unknown top-level property
- non-literal capability declaration
- identifier reference not declared in module

Errors block package build.

Warnings do not block package build.

## oxc implementation guidance

The extractor should use OXC for parsing and AST walking.

Suggested flow:

1. Parse `src/package.ts`
2. Validate import of `definePackage`
3. Locate default export package definition
4. Resolve allowed local identifier indirections
5. Validate top-level package object shape
6. Extract metadata and handler references
7. Emit normalized analysis output plus diagnostics

Important constraint:

- no evaluation of user code
- no executing package modules

## examples

### accepted

```ts
import { definePackage } from "@gsv/package-worker";

async function doctor(ctx) {
  await ctx.stdout.write("ok\\n");
}

const pkg = definePackage({
  meta: {
    displayName: "Doctor",
    capabilities: {
      kernel: [],
      outbound: [],
    },
  },
  commands: {
    doctor,
  },
});

export default pkg;
```

### rejected: computed metadata

```ts
import { definePackage } from "@gsv/package-worker";

const title = "Doctor";

export default definePackage({
  meta: {
    displayName: title,
  },
});
```

### rejected: unsupported app form

```ts
import { definePackage } from "@gsv/package-worker";

const app = {
  fetch: async (request, ctx) => new Response("ok"),
};

export default definePackage({
  meta: {
    displayName: "Example",
  },
  app,
});
```

## immediate implementation target

The first implementation should support:

- direct export form
- local-const export form
- literal metadata extraction
- local handler references
- structured diagnostics

It does not need to support:

- cross-module metadata indirection
- partial evaluation
- multiple package definitions per file
- async app routing hooks
