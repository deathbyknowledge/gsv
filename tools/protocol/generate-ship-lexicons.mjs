import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";
import { SHIP_LEXICON_CONSTANTS, SHIP_LEXICON_IMPORTS, SHIP_LEXICON_LIMITS, SHIP_LEXICON_RULES } from "./ship-lexicon-rules.mjs";

/**
 * Emit the SDK's validators and types for the lexicons under lexicons/. Each
 * lexicon is read through a strict schema of the Lexicon this generator maps,
 * so a type, format or keyword it can't map fails here instead of being
 * skipped. As zod/mini sees Lexicon:
 *   - a string's minLength and maxLength count UTF-8 bytes; minGraphemes and
 *     maxGraphemes count graphemes; format is one of did, handle, at-uri,
 *     datetime and cid;
 *   - enum is closed, knownValues only advise, and const is a literal;
 *   - unknown is any JSON object;
 *   - a union is chosen by $type, and an open one also takes a $type it doesn't list;
 *   - a blob is exactly {$type, ref, mimeType, size}, within accept and maxSize.
 * An object drops fields its lexicon doesn't declare, since Lexicon objects are
 * open and a later version may add one. ship-lexicon-rules.mjs adds what
 * Lexicon can't say, and names the limits code checks before it sends.
 *
 * With --check, the output must be current and no other source may write a
 * space.ship NSID: code takes it from the generated module.
 */

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(toolDirectory, "..", "..");
const lexiconRoot = join(repositoryRoot, "lexicons");
const outputPath = join(repositoryRoot, "packages", "gsv", "src", "protocol", "generated", "ship-lexicons.ts");

const description = z.string().optional();
const count = z.int().nonnegative().optional();
const stringType = z.strictObject({
  type: z.literal("string"),
  description,
  format: z.enum(["at-uri", "cid", "datetime", "did", "handle"]).optional(),
  minLength: count,
  maxLength: count,
  minGraphemes: count,
  maxGraphemes: count,
  enum: z.array(z.string()).nonempty().optional(),
  knownValues: z.array(z.string()).nonempty().optional(),
  const: z.string().optional(),
});
const integerType = z.strictObject({
  type: z.literal("integer"),
  description,
  minimum: z.int().optional(),
  maximum: z.int().optional(),
  enum: z.array(z.int()).nonempty().optional(),
  const: z.int().optional(),
});
const booleanType = z.strictObject({ type: z.literal("boolean"), description, const: z.boolean().optional() });
const unknownType = z.strictObject({ type: z.literal("unknown"), description });
const blobType = z.strictObject({
  type: z.literal("blob"),
  description,
  accept: z.array(z.string()).nonempty().optional(),
  maxSize: z.int().positive().optional(),
});
const refType = z.strictObject({ type: z.literal("ref"), description, ref: z.string() });
const unionType = z.strictObject({
  type: z.literal("union"),
  description,
  refs: z.array(z.string()).nonempty(),
  closed: z.boolean().optional(),
});
const arrayType = z.strictObject({
  type: z.literal("array"),
  description,
  minLength: count,
  maxLength: count,
  get items() {
    return fieldType;
  },
});
const objectType = z.strictObject({
  type: z.literal("object"),
  description,
  required: z.array(z.string()).optional(),
  nullable: z.array(z.string()).optional(),
  get properties() {
    return z.record(z.string(), fieldType);
  },
});
const fieldTypes = [stringType, integerType, booleanType, unknownType, blobType, refType, unionType, arrayType, objectType];
const fieldType = z.discriminatedUnion("type", fieldTypes);
// Query parameters arrive as strings, so only string parameters map without coercion.
const parametersType = z.strictObject({
  type: z.literal("params"),
  description,
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), stringType),
});
const bodyType = z.strictObject({
  description,
  encoding: z.string(),
  schema: z.discriminatedUnion("type", [objectType, refType]).optional(),
});
const errorsType = z.array(z.strictObject({ name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/), description })).optional();
const queryType = z.strictObject({
  type: z.literal("query"),
  description,
  parameters: parametersType.optional(),
  output: bodyType.optional(),
  errors: errorsType,
});
const procedureType = z.strictObject({
  type: z.literal("procedure"),
  description,
  parameters: parametersType.optional(),
  input: bodyType.optional(),
  output: bodyType.optional(),
  errors: errorsType,
});
const recordType = z.strictObject({ type: z.literal("record"), description, key: z.string(), record: objectType });
const lexiconType = z.strictObject({
  lexicon: z.literal(1),
  id: z.string(),
  description,
  revision: z.int().optional(),
  defs: z.record(z.string(), z.discriminatedUnion("type", [queryType, procedureType, recordType, ...fieldTypes])),
});

const PRIMARY_TYPES = new Set(["query", "procedure", "record"]);
const SHIP = { rules: SHIP_LEXICON_RULES, imports: SHIP_LEXICON_IMPORTS, limits: SHIP_LEXICON_LIMITS, constants: SHIP_LEXICON_CONSTANTS };

/** Every lexicon under `root`, as `{ path, document }` with `path` relative to the root. */
export function readLexiconFiles(root = lexiconRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".json")) {
        files.push({ path: relative(root, path).split(sep).join("/"), document: JSON.parse(readFileSync(path, "utf8")) });
      }
    }
  };
  visit(root);
  return files;
}

/** The generated module for these lexicons, as TypeScript source, under Ship's rules unless it's given others. */
export function generateShipLexicons(files, { rules = {}, imports = {}, limits = {}, constants = {} } = SHIP) {
  const lexicons = files.map(({ path, document }) => readLexicon(path, document));
  const definitions = new Map();
  for (const lexicon of lexicons) {
    for (const [name, definition] of Object.entries(lexicon.defs)) {
      definitions.set(`${lexicon.id}#${name}`, { lexicon, name, definition });
    }
  }
  const limitNames = new Map();
  for (const [name, field] of Object.entries(limits)) {
    if (limitNames.has(field)) throw new Error(`${limitNames.get(field)} and ${name} both name the limit of ${field}`);
    limitNames.set(field, name);
  }
  const state = {
    rules,
    usedRules: new Set(),
    limits: limitNames,
    usedLimits: new Set(),
    helpers: new Set(),
    json: new Set(),
    names: new Map(),
    units: new Map(),
    order: [],
  };
  const generator = { definitions, state };

  const nsids = [];
  for (const lexicon of lexicons) {
    const main = lexicon.defs.main;
    nsids.push(...docComment(main.description, ""));
    if (main.type === "record") {
      const base = `SHIP_${screaming(lexicon.name)}`;
      nsids.push(`export const ${claim(state, `${base}_COLLECTION`, lexicon.id)} = ${JSON.stringify(lexicon.id)};`);
      if (main.key.startsWith("literal:")) {
        nsids.push(`export const ${claim(state, `${base}_RKEY`, lexicon.id)} = ${JSON.stringify(main.key.slice("literal:".length))};`);
      }
    } else {
      nsids.push(`export const ${claim(state, screaming(lexicon.name), lexicon.id)} = ${JSON.stringify(lexicon.id)};`);
    }
  }
  const ruleConstants = Object.entries(constants).map(([name, value]) => `export const ${claim(state, name, "the rules")} = ${number(value)};`);

  for (const lexicon of lexicons) {
    for (const name of Object.keys(lexicon.defs)) {
      if (name !== "main") emitDefinition(generator, `${lexicon.id}#${name}`);
    }
    emitMain(generator, lexicon);
  }

  for (const [key, fields] of Object.entries(rules)) {
    for (const field of Object.keys(fields)) {
      if (!state.usedRules.has(`${key} ${field}`)) throw new Error(`The rule for ${key} ${field} names nothing in the lexicons`);
    }
  }
  for (const [field, name] of limitNames) {
    if (!state.usedLimits.has(name)) {
      throw new Error(`${name} names ${field}, which isn't a string or array with a maxLength, or an integer with a maximum`);
    }
  }
  const units = state.order.map((key) => state.units.get(key));
  for (const name of Object.keys(constants)) {
    if (!units.some((code) => new RegExp(`\\b${name}\\b`).test(code))) throw new Error(`No rule uses ${name}`);
  }

  const blocks = [nsids.join("\n")];
  if (ruleConstants.length > 0) blocks.push(ruleConstants.join("\n"));
  const body = [...blocks, ...units].join("\n\n");
  const importLines = ['import { z } from "zod/mini";'];
  const named = new Map(Object.entries(imports).map(([module, names]) => [module, names.filter((name) => new RegExp(`\\b${name}\\b`).test(body))]));
  named.set("../json", [...new Set([...(named.get("../json") ?? []), ...state.json])]);
  named.set("../lexicon", [...new Set([...(named.get("../lexicon") ?? []), ...state.helpers])]);
  for (const [module, names] of [...named].sort(([a], [b]) => a.localeCompare(b))) {
    if (names.length === 0) continue;
    const sorted = names.sort((a, b) => a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")));
    importLines.push(`import { ${sorted.join(", ")} } from ${JSON.stringify(module)};`);
  }
  return [
    "// Generated by tools/protocol/generate-ship-lexicons.mjs from lexicons/ and",
    "// tools/protocol/ship-lexicon-rules.mjs. Do not edit by hand.",
    importLines.join("\n"),
    "",
    body,
    "",
  ].join("\n");
}

function readLexicon(path, document) {
  const lexicon = lexiconType.parse(document);
  if (`${lexicon.id.split(".").join("/")}.json` !== path) throw new Error(`${path} must hold the lexicon its path names, not ${lexicon.id}`);
  const main = lexicon.defs.main;
  if (!main || !PRIMARY_TYPES.has(main.type)) throw new Error(`${lexicon.id} needs a main query, procedure or record`);
  for (const [name, definition] of Object.entries(lexicon.defs)) {
    if (name !== "main" && PRIMARY_TYPES.has(definition.type)) throw new Error(`${lexicon.id}#${name}: only main may be a ${definition.type}`);
  }
  const errors = (main.errors ?? []).map((error) => error.name);
  const repeated = errors.find((name, index) => errors.indexOf(name) !== index);
  if (repeated) throw new Error(`${lexicon.id} declares the error ${repeated} twice`);
  return { ...lexicon, name: lexicon.id.split(".").at(-1) };
}

function emitMain(generator, lexicon) {
  const main = lexicon.defs.main;
  const typePrefix = pascal(lexicon.name);
  if (main.type === "record") {
    emitObject(generator, {
      key: `${lexicon.id}#main.record`,
      lexicon,
      object: main.record,
      typeName: `Ship${typePrefix}Record`,
      description: main.description,
      leading: { type: `$type: ${JSON.stringify(lexicon.id)};`, schema: `$type: z.literal(SHIP_${screaming(lexicon.name)}_COLLECTION),` },
    });
    return;
  }
  if (main.parameters) {
    emitObject(generator, {
      key: `${lexicon.id}#main.params`,
      lexicon,
      object: { ...main.parameters, type: "object" },
      typeName: `${typePrefix}Params`,
      description: main.parameters.description,
    });
  }
  for (const part of ["input", "output"]) {
    const body = main[part];
    if (!body?.schema) {
      if (part === "input" && body) throw new Error(`${lexicon.id}: an input without a JSON schema isn't supported`);
      continue;
    }
    if (body.encoding !== "application/json") throw new Error(`${lexicon.id}: a ${part} schema must be application/json`);
    const key = `${lexicon.id}#main.${part}`;
    const typeName = `${typePrefix}${pascal(part)}`;
    if (body.schema.type === "ref") {
      const target = resolveReference(generator, lexicon, body.schema.ref, key);
      unit(generator, key, [target.key], [
        ...docComment(body.description, ""),
        `export type ${claim(generator.state, typeName, key)} = ${target.type};`,
        `export const ${claim(generator.state, schemaName(typeName), key)} = ${target.schema};`,
      ]);
    } else {
      emitObject(generator, { key, lexicon, object: body.schema, typeName, description: body.schema.description ?? body.description });
    }
  }
}

function emitDefinition(generator, key) {
  const { state, definitions } = generator;
  if (state.units.has(key)) return;
  const entry = definitions.get(key);
  if (!entry) throw new Error(`Unresolved lexicon reference ${key}`);
  const { lexicon, name, definition } = entry;
  const typeName = `${pascal(lexicon.name)}${pascal(name)}`;
  if (definition.type === "object") {
    emitObject(generator, { key, lexicon, object: definition, typeName, description: definition.description });
    return;
  }
  state.units.set(key, null);
  const field = fieldCode(generator, definition, { lexicon, path: key, constantPrefix: `${screaming(lexicon.name)}_${screaming(name)}` });
  finishUnit(generator, key, field.deps, [
    ...field.constants,
    ...docComment(definition.description, ""),
    `export type ${claim(state, typeName, key)} = ${field.type};`,
    `export const ${claim(state, schemaName(typeName), key)} = ${render(field)} satisfies z.ZodMiniType<${typeName}>;`,
  ]);
}

function emitObject(generator, { key, lexicon, object, typeName, description: text, leading }) {
  const { state } = generator;
  if (state.units.has(key)) return;
  state.units.set(key, null);
  const fieldRules = state.rules[key] ?? {};
  const required = new Set(object.required ?? []);
  const nullable = new Set(object.nullable ?? []);
  for (const name of [...required, ...nullable]) {
    if (!(name in object.properties)) throw new Error(`${key} lists ${name}, which it doesn't declare`);
  }
  const deps = new Set();
  const constants = [];
  const typeLines = leading ? [`  ${leading.type}`] : [];
  const schemaLines = leading ? [`  ${leading.schema}`] : [];
  const fields = Object.entries(object.properties).map(([name, definition]) => ({ name, definition, rule: fieldRules[name] }));
  for (const [name, rule] of Object.entries(fieldRules)) {
    if (name === "$refine" || name in object.properties) continue;
    if (!rule.add) throw new Error(`The rule for ${key} ${name} names a field the lexicon doesn't declare`);
    fields.push({ name, rule });
  }
  const definitionName = key.slice(key.indexOf("#") + 1).split(".")[0];
  for (const { name, definition, rule } of fields) {
    const path = `${key} ${name}`;
    let field;
    if (rule) state.usedRules.add(path);
    if (rule?.add) {
      if (definition) throw new Error(`${path} is declared; a rule adds only a field Lexicon can't declare`);
      field = { type: rule.add.type, base: rule.add.schema, checks: [], deps: [], constants: [] };
    } else if (rule?.kindUnion) {
      if (definition.type !== "unknown") throw new Error(`${path} must be unknown to hold a kind union`);
      field = kindUnion(generator, lexicon, rule, path);
    } else {
      field = fieldCode(generator, definition, {
        lexicon,
        path,
        constantPrefix: `${screaming(lexicon.name)}${definitionName === "main" ? "" : `_${screaming(definitionName)}`}_${screaming(name)}`,
        limit: state.limits.get(path),
      });
    }
    if (rule?.check) field = { ...field, checks: [...field.checks, ...rule.check] };
    for (const dep of field.deps) deps.add(dep);
    constants.push(...field.constants);
    const optional = !required.has(name);
    let schema = render(field);
    if (nullable.has(name)) schema = `z.nullable(${schema})`;
    if (optional) schema = `z.optional(${schema})`;
    typeLines.push(...docComment(definition?.description ?? rule?.add?.description, "  "));
    typeLines.push(`  ${propertyName(name)}${optional ? "?" : ""}: ${field.type}${nullable.has(name) ? " | null" : ""};`);
    if (rule?.why) schemaLines.push(`  // ${rule.why}`);
    schemaLines.push(`  ${propertyName(name)}: ${schema},`);
  }
  let schema = `z.object({\n${schemaLines.join("\n")}\n})`;
  const refine = fieldRules.$refine;
  if (refine) {
    state.usedRules.add(`${key} $refine`);
    schema += `.check(\n  // ${refine.why}\n  ${refine.check},\n)`;
  }
  finishUnit(generator, key, deps, [
    ...constants,
    ...docComment(text, ""),
    `export type ${claim(state, typeName, key)} = {\n${typeLines.join("\n")}\n};`,
    `export const ${claim(state, schemaName(typeName), key)} = ${schema} satisfies z.ZodMiniType<${typeName}>;`,
  ]);
}

/** A field's TypeScript type and zod schema; checks join the schema's own `.check(...)`. */
function fieldCode(generator, definition, context) {
  const { state } = generator;
  const plain = (type, base, checks = []) => ({ type, base, checks, deps: [], constants: [] });
  switch (definition.type) {
    case "string": {
      if (definition.const !== undefined) return plain(JSON.stringify(definition.const), `z.literal(${JSON.stringify(definition.const)})`);
      if (definition.enum) return plain(definition.enum.map((value) => JSON.stringify(value)).join(" | "), `z.enum(${list(definition.enum)})`);
      const checks = [];
      const constants = [];
      if (definition.minLength === 1) checks.push("z.minLength(1)");
      else if (definition.minLength) checks.push(helper(state, "utf8MinLength", number(definition.minLength)));
      if (definition.maxLength !== undefined) checks.push(helper(state, "utf8MaxLength", upperLimit(state, context, definition.maxLength, constants)));
      if (definition.minGraphemes) checks.push(helper(state, "minGraphemes", number(definition.minGraphemes)));
      if (definition.maxGraphemes !== undefined) checks.push(helper(state, "maxGraphemes", number(definition.maxGraphemes)));
      if (definition.format) {
        state.helpers.add("stringFormat");
        checks.push(`stringFormat(${JSON.stringify(definition.format)})`);
      }
      return { ...plain("string", "z.string()", checks), constants };
    }
    case "integer": {
      if (definition.const !== undefined) return plain(String(definition.const), `z.literal(${definition.const})`);
      if (definition.enum) return plain(definition.enum.join(" | "), `z.literal(${list(definition.enum)})`);
      const checks = [];
      const constants = [];
      if (definition.minimum !== undefined) checks.push(`z.gte(${number(definition.minimum)})`);
      if (definition.maximum !== undefined) checks.push(`z.lte(${upperLimit(state, context, definition.maximum, constants)})`);
      return { ...plain("number", "z.int()", checks), constants };
    }
    case "boolean":
      return definition.const === undefined
        ? plain("boolean", "z.boolean()")
        : plain(String(definition.const), `z.literal(${definition.const})`);
    case "unknown":
      state.json.add("jsonObjectSchema");
      state.json.add("type JsonObject");
      return plain("JsonObject", "jsonObjectSchema");
    case "blob":
      return blobCode(state, definition, context.constantPrefix);
    case "ref": {
      const target = resolveReference(generator, context.lexicon, definition.ref, context.path);
      return { type: target.type, base: target.schema, checks: [], deps: [target.key], constants: [] };
    }
    case "union":
      return unionCode(generator, definition, context);
    case "array": {
      const item = fieldCode(generator, definition.items, { ...context, path: `${context.path}[]`, limit: undefined });
      const checks = [];
      const constants = [...item.constants];
      if (definition.minLength) checks.push(`z.minLength(${number(definition.minLength)})`);
      if (definition.maxLength !== undefined) checks.push(`z.maxLength(${upperLimit(state, context, definition.maxLength, constants)})`);
      const type = item.type.includes("|") ? `(${item.type})[]` : `${item.type}[]`;
      return { type, base: `z.array(${render(item)})`, checks, deps: item.deps, constants };
    }
    case "object":
      throw new Error(`${context.path}: name a nested object as a definition and refer to it`);
  }
}

function blobCode(state, definition, prefix) {
  state.helpers.add("stringFormat");
  state.helpers.add("type LexiconBlob");
  const constants = [];
  let mimeType = "z.string()";
  if (definition.accept) {
    const name = claim(state, `${prefix}_MIME_TYPES`, prefix);
    constants.push(`export const ${name} = ${list(definition.accept)} as const;`);
    if (definition.accept.some((pattern) => pattern.includes("*"))) {
      state.helpers.add("mimeTypeAccept");
      mimeType = `z.string().check(mimeTypeAccept(${name}))`;
    } else {
      mimeType = `z.enum(${name})`;
    }
  } else {
    state.helpers.add("mimeTypeAccept");
    mimeType = 'z.string().check(mimeTypeAccept(["*/*"]))';
  }
  let size = "z.int().check(z.gte(0))";
  if (definition.maxSize !== undefined) {
    const name = claim(state, `${prefix}_MAX_BYTES`, prefix);
    constants.push(`export const ${name} = ${number(definition.maxSize)};`);
    size = `z.int().check(z.gte(0), z.lte(${name}))`;
  }
  const base = [
    "z.strictObject({",
    '    $type: z.literal("blob"),',
    '    ref: z.strictObject({ $link: z.string().check(stringFormat("cid")) }),',
    `    mimeType: ${mimeType},`,
    `    size: ${size},`,
    "  })",
  ].join("\n");
  return { type: "LexiconBlob", base, checks: [], deps: [], constants };
}

/** A $type union: each listed object carries its $type, and an open union takes any other $type too. */
function unionCode(generator, definition, context) {
  const variants = definition.refs.map((reference) => {
    const target = resolveReference(generator, context.lexicon, reference, context.path);
    if (generator.definitions.get(target.key).definition.type !== "object") throw new Error(`${context.path}: union member ${reference} must be an object`);
    const type = JSON.stringify(target.key);
    return { target, schema: `z.extend(${target.schema}, { $type: z.literal(${type}) })`, type: `({ $type: ${type} } & ${target.type})` };
  });
  const known = variants.map((variant) => variant.target.key);
  let schema = `z.discriminatedUnion("$type", [${variants.map((variant) => variant.schema).join(", ")}])`;
  let type = variants.map((variant) => variant.type).join(" | ");
  if (!definition.closed) {
    schema = `z.union([${schema}, z.catchall(z.object({ $type: z.string().check(z.refine((type) => !${list(known)}.includes(type))) }), z.json())])`;
    type += " | { $type: string; [key: string]: JsonValue }";
    generator.state.json.add("type JsonValue");
  }
  return { type, base: schema, checks: [], deps: variants.map((variant) => variant.target.key), constants: [] };
}

/** A rule's `kind` union over local objects, emitted once under its name. */
function kindUnion(generator, lexicon, rule, path) {
  const key = `${lexicon.id}#${rule.name}`;
  if (generator.definitions.has(key)) throw new Error(`${path}: ${rule.name} already names a definition`);
  const typeName = `${pascal(lexicon.name)}${pascal(rule.name)}`;
  if (!generator.state.units.has(key)) {
    generator.state.units.set(key, null);
    const kinds = new Set();
    const variants = rule.kindUnion.map((reference) => {
      if (!reference.startsWith("#")) throw new Error(`${path}: a kind union holds local definitions, not ${reference}`);
      const target = resolveReference(generator, lexicon, reference, path);
      const object = generator.definitions.get(target.key).definition;
      const kind = object.type === "object" ? object.properties.kind : undefined;
      if (kind?.type !== "string" || kind.const === undefined || !object.required?.includes("kind")) {
        throw new Error(`${path}: ${reference} needs a required kind with a const`);
      }
      if (kinds.has(kind.const)) throw new Error(`${path}: two members share the kind ${kind.const}`);
      kinds.add(kind.const);
      return target;
    });
    finishUnit(generator, key, variants.map((variant) => variant.key), [
      `export type ${claim(generator.state, typeName, key)} = ${variants.map((variant) => variant.type).join(" | ")};`,
      `// ${rule.why}`,
      `export const ${claim(generator.state, schemaName(typeName), key)} = z.discriminatedUnion("kind", [`,
      ...variants.map((variant) => `  ${variant.schema},`),
      `]) satisfies z.ZodMiniType<${typeName}>;`,
    ]);
  }
  return { type: typeName, base: schemaName(typeName), checks: [], deps: [key], constants: [] };
}

function resolveReference(generator, lexicon, reference, path) {
  const key = reference.startsWith("#") ? `${lexicon.id}${reference}` : reference.includes("#") ? reference : `${reference}#main`;
  const entry = generator.definitions.get(key);
  if (!entry) throw new Error(`${path}: unresolved reference ${reference}`);
  if (entry.name === "main") throw new Error(`${path}: ${reference} is a ${entry.definition.type}, which can't be referred to`);
  emitDefinition(generator, key);
  const typeName = `${pascal(entry.lexicon.name)}${pascal(entry.name)}`;
  return { key, type: typeName, schema: schemaName(typeName) };
}

function unit(generator, key, deps, lines) {
  generator.state.units.set(key, null);
  finishUnit(generator, key, deps, lines);
}

/** Records a unit once its dependencies are out, so the module declares each schema before use. */
function finishUnit(generator, key, deps, lines) {
  for (const dep of deps) {
    if (generator.state.units.get(dep) === null && dep !== key && !generator.state.order.includes(dep)) {
      throw new Error(`${key} and ${dep} refer to each other, which isn't supported`);
    }
  }
  generator.state.units.set(key, lines.join("\n"));
  generator.state.order.push(key);
}

function list(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function render(field) {
  return field.checks.length ? `${field.base}.check(${field.checks.join(", ")})` : field.base;
}

function helper(state, name, argument) {
  state.helpers.add(name);
  return `${name}(${argument})`;
}

/** A field's upper limit, exported under the name SHIP_LEXICON_LIMITS gives it, if any, so code can check it too. */
function upperLimit(state, context, value, constants) {
  if (!context.limit) return number(value);
  state.usedLimits.add(context.limit);
  constants.push(`export const ${claim(state, context.limit, context.path)} = ${number(value)};`);
  return context.limit;
}

/** Claims an exported name once; two lexicons can't generate the same one. */
function claim(state, name, owner) {
  const existing = state.names.get(name);
  if (existing !== undefined && existing !== owner) throw new Error(`${owner} and ${existing} both generate ${name}`);
  state.names.set(name, owner);
  return name;
}

function docComment(text, indent) {
  if (!text) return [];
  return [`${indent}/** ${text.replaceAll("*/", "*\\/")} */`];
}

function propertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function number(value) {
  return Math.abs(value) >= 1_000 ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_") : String(value);
}

function pascal(name) {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function schemaName(typeName) {
  return `${typeName.charAt(0).toLowerCase()}${typeName.slice(1)}Schema`;
}

function screaming(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

// Fixtures and records that can't change may name an NSID directly.
const NSID_LITERAL_EXEMPTIONS = [
  /(^|\/)generated\//,
  /^tools\/protocol\/ship-lexicon-rules\.mjs$/,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)(test|test-integration|test-fixtures|smoke)\//,
  // A shipped migration can't change.
  /\/schema\/v\d{3}_[^/]+\.ts$/,
  // Development-only fixtures for the web UI.
  /^web\/src\/app\/services\/gateway\/mockGateway\.ts$/,
];
const NSID = /^space\.ship\.[A-Za-z][A-Za-z0-9]*(?:#[A-Za-z][A-Za-z0-9]*)?$/;
const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/**
 * String literals outside the generated module that are a space.ship NSID, each
 * as `file:line nsid`. Comments and messages may mention one; code names it
 * through the generated constant.
 */
export function findShipNsidLiterals(root = repositoryRoot) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.js", "*.mjs", "*.cjs"],
    { cwd: root, encoding: "utf8" },
  ).split("\0").filter(Boolean);
  const found = [];
  for (const file of files) {
    if (NSID_LITERAL_EXEMPTIONS.some((pattern) => pattern.test(file)) || !existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes("space.ship.")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const nsid = LITERAL_KINDS.has(node.kind) ? NSID.exec(node.text)?.[0] : undefined;
      if (nsid) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${nsid}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generated = generateShipLexicons(readLexiconFiles());
  if (process.argv.includes("--check")) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (current !== generated) {
      console.error("Ship lexicon validators are stale; run npm run protocol:generate");
      process.exitCode = 1;
    }
    const literals = findShipNsidLiterals();
    if (literals.length > 0) {
      console.error([
        "These name a space.ship NSID directly. Define it in lexicons/ and import its constant from the generated module:",
        ...literals.map((literal) => `  ${literal}`),
      ].join("\n"));
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outputPath, generated);
  }
}
