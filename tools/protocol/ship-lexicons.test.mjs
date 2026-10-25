import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { isCid, isDatetime, isDid, isHandle, isResourceUri } from "@atcute/lexicons/syntax";
import {
  Lexicons, jsonToLex, lexArray, lexBlob, lexBoolean, lexInteger, lexObject, lexRecord, lexString, lexToken, lexUnknown,
  lexXrpcProcedure, lexXrpcQuery, lexiconDoc,
} from "@atproto/lexicon";
import { build } from "esbuild";
import ts from "typescript";
import { findShipNsidLiterals, generateShipLexicons, readLexiconFiles } from "./generate-ship-lexicons.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const generatedDirectory = join(repositoryRoot, "packages", "gsv", "src", "protocol", "generated");
// The same bytes as CIDv1 raw, CIDv1 dag-cbor, CIDv0 and CIDv1 dag-pb.
const RAW_CID = "bafkreihf2w4xce4657vtnvxnxgjy7isgoqgjbwraanrgjb7lfvozmrvoyy";
const DAG_CBOR_CID = "bafyreihf2w4xce4657vtnvxnxgjy7isgoqgjbwraanrgjb7lfvozmrvoyy";
const V0_CID = "Qmdoq6FDxYYYSWRhU7LiVtwe4RbKDSsf8xxj2uFV69ueHs";
const DAG_PB_CID = "bafybeihf2w4xce4657vtnvxnxgjy7isgoqgjbwraanrgjb7lfvozmrvoyy";
const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
// lexiconDoc checks each definition but hands it back as written; the schema for its type drops keys it doesn't know.
const OFFICIAL_DEFINITIONS = {
  array: lexArray, blob: lexBlob, boolean: lexBoolean, integer: lexInteger, object: lexObject, procedure: lexXrpcProcedure,
  query: lexXrpcQuery, record: lexRecord, string: lexString, token: lexToken, unknown: lexUnknown,
};

test("each lexicon is Lexicon v1 as @atproto/lexicon reads it, and every reference resolves", () => {
  const files = readLexiconFiles();
  assert.ok(files.length > 0);
  for (const { path, document } of files) {
    // A misspelt keyword shows up as a difference.
    assert.deepEqual(officialRoundTrip(document), document, path);
    assert.match(document.id, /^space\.ship\.[a-z][A-Za-z]*$/, path);
  }
  const lexicons = new Lexicons(files.map(({ document }) => document));
  for (const { document } of files) {
    for (const reference of references(document.defs)) {
      assert.ok(lexicons.getDef(lexicons.resolveLexUri(document.id, reference)), `${document.id} refers to ${reference}`);
    }
  }
});

test("a keyword Lexicon doesn't define fails both the official round trip and the generator", () => {
  const typo = fixture("test.fixture.typo", {
    main: procedure({ type: "object", properties: { name: { type: "string", maxlength: 4 } } }),
  });
  assert.notDeepEqual(officialRoundTrip(typo), typo);
  assert.throws(() => generateShipLexicons([file(typo)], {}), /maxlength/);
});

const THING = fixture("test.fixture.thing", {
  main: {
    type: "procedure",
    input: {
      encoding: "application/json",
      schema: {
        type: "object",
        required: ["bytes"],
        nullable: ["maybe"],
        properties: {
          bytes: { type: "string", minLength: 2, maxLength: 4 },
          graphemes: { type: "string", minGraphemes: 1, maxGraphemes: 2 },
          known: { type: "string", knownValues: ["a", "b"] },
          closed: { type: "string", enum: ["a", "b"] },
          fixed: { type: "string", const: "x" },
          did: { type: "string", format: "did" },
          handle: { type: "string", format: "handle" },
          uri: { type: "string", format: "at-uri" },
          at: { type: "string", format: "datetime" },
          cid: { type: "string", format: "cid" },
          count: { type: "integer", minimum: 1, maximum: 3 },
          level: { type: "integer", enum: [1, 2] },
          flag: { type: "boolean" },
          maybe: { type: "string" },
          data: { type: "unknown" },
          tags: { type: "array", minLength: 1, maxLength: 2, items: { type: "string", maxLength: 3 } },
          open: { type: "union", refs: ["#a", "#b"] },
          shut: { type: "union", refs: ["#a", "test.fixture.common#c"], closed: true },
          file: { type: "blob", accept: ["image/*", "text/plain"], maxSize: 10 },
          picture: { type: "blob", accept: ["image/png"] },
          any: { type: "blob" },
          shared: { type: "ref", ref: "test.fixture.common#c" },
        },
      },
    },
    output: { encoding: "application/json", schema: { type: "ref", ref: "#a" } },
  },
  a: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
  b: { type: "object", properties: { s: { type: "string" } } },
});
const COMMON = fixture("test.fixture.common", {
  main: {
    type: "query",
    parameters: { type: "params", required: ["q"], properties: { q: { type: "string", maxLength: 8 } } },
    output: { encoding: "*/*" },
  },
  c: { type: "object", required: ["kind"], properties: { kind: { type: "string", const: "c" } } },
});
const NOTE = fixture("test.fixture.note", {
  main: {
    type: "record",
    key: "tid",
    record: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", maxGraphemes: 3 }, embed: { type: "ref", ref: "#embed" } },
    },
  },
  embed: { type: "object", properties: { alt: { type: "string" } } },
});
const FIXTURES = [THING, COMMON, NOTE];
const fixtureSource = generateShipLexicons(FIXTURES.map(file), {});
// Lexicons rewrites the references in the documents it holds, so it holds copies.
const official = new Lexicons(structuredClone(FIXTURES));
const generated = await load(fixtureSource);

const BLOB = { $type: "blob", ref: { $link: RAW_CID }, mimeType: "image/png", size: 10 };
// Where the reference validator differs, `theirs` says how and `why` says why.
const INPUT_CASES = [
  { what: "a minimal input", input: {}, ours: "accept" },
  { what: "maxLength in UTF-8 bytes: two two-byte characters", input: { bytes: "éé" }, ours: "accept" },
  { what: "maxLength in UTF-8 bytes: three code units but six bytes", input: { bytes: "ééé" }, ours: "refuse" },
  { what: "minLength in UTF-8 bytes: one code unit but two bytes", input: { bytes: "é" }, ours: "accept" },
  { what: "fewer bytes than minLength", input: { bytes: "a" }, ours: "refuse" },
  { what: "graphemes as people see them: two, of eight code units", input: { graphemes: "👍🏽👍🏽" }, ours: "accept" },
  { what: "more graphemes than maxGraphemes", input: { graphemes: "abc" }, ours: "refuse" },
  { what: "fewer graphemes than minGraphemes", input: { graphemes: "" }, ours: "refuse" },
  { what: "a value knownValues doesn't list", input: { known: "c" }, ours: "accept" },
  { what: "a value enum doesn't list", input: { closed: "c" }, ours: "refuse" },
  { what: "the const", input: { fixed: "x" }, ours: "accept" },
  { what: "a value other than const", input: { fixed: "y" }, ours: "refuse" },
  { what: "a did:plc", input: { did: ALICE }, ours: "accept" },
  { what: "a DID of another method", input: { did: "did:web:example.com" }, ours: "accept" },
  { what: "a DID without an identifier", input: { did: "did:example" }, ours: "refuse" },
  { what: "a handle", input: { handle: "alice.ship.space" }, ours: "accept" },
  { what: "a handle without a domain", input: { handle: "alice" }, ours: "refuse" },
  { what: "an at-uri", input: { uri: `at://${ALICE}/test.fixture.note/3jzfcijpj2z2a` }, ours: "accept" },
  { what: "an at-uri by handle", input: { uri: "at://alice.ship.space" }, ours: "accept" },
  { what: "a URI that isn't at://", input: { uri: "https://alice.ship.space" }, ours: "refuse" },
  { what: "a datetime", input: { at: "2026-10-25T12:00:00.000Z" }, ours: "accept" },
  { what: "a date without a time", input: { at: "2026-10-25" }, ours: "refuse" },
  { what: "a raw CID", input: { cid: RAW_CID }, ours: "accept" },
  { what: "a dag-cbor CID", input: { cid: DAG_CBOR_CID }, ours: "accept" },
  { what: "a CIDv0", input: { cid: V0_CID }, ours: "refuse", theirs: "accept", why: "a DASL CID is CIDv1" },
  { what: "a dag-pb CID", input: { cid: DAG_PB_CID }, ours: "refuse", theirs: "accept", why: "a DASL CID is dag-cbor or raw" },
  { what: "the minimum", input: { count: 1 }, ours: "accept" },
  { what: "below the minimum", input: { count: 0 }, ours: "refuse" },
  { what: "above the maximum", input: { count: 4 }, ours: "refuse" },
  { what: "a fraction", input: { count: 1.5 }, ours: "refuse" },
  { what: "an integer enum member", input: { level: 2 }, ours: "accept" },
  { what: "an integer outside the enum", input: { level: 3 }, ours: "refuse" },
  { what: "a boolean", input: { flag: false }, ours: "accept" },
  { what: "a string for a boolean", input: { flag: "true" }, ours: "refuse" },
  { what: "null where nullable", input: { maybe: null }, ours: "accept" },
  { what: "null where not nullable", input: { bytes: null }, ours: "refuse" },
  { what: "a missing required field", input: { bytes: undefined }, ours: "refuse" },
  { what: "an object for unknown", input: { data: { $type: "anything", nested: [1] } }, ours: "accept" },
  { what: "a string for unknown", input: { data: "x" }, ours: "refuse" },
  { what: "an array for unknown", input: { data: [] }, ours: "refuse", theirs: "accept", why: "Lexicon's unknown is a data object" },
  { what: "an array within its lengths", input: { tags: ["a", "b"] }, ours: "accept" },
  { what: "an empty array below minLength", input: { tags: [] }, ours: "refuse" },
  { what: "an array above maxLength", input: { tags: ["a", "b", "c"] }, ours: "refuse" },
  { what: "an array item over its own limit", input: { tags: ["abcd"] }, ours: "refuse" },
  { what: "a listed union member", input: { open: { $type: "test.fixture.thing#a", n: 1 } }, ours: "accept" },
  { what: "a listed member that breaks its own definition", input: { open: { $type: "test.fixture.thing#a" } }, ours: "refuse" },
  { what: "an unlisted $type in an open union", input: { open: { $type: "test.other.thing#x", anything: [true] } }, ours: "accept" },
  { what: "a union member without $type", input: { open: { n: 1 } }, ours: "refuse" },
  { what: "another lexicon's member of a closed union", input: { shut: { $type: "test.fixture.common#c", kind: "c" } }, ours: "accept" },
  { what: "an unlisted $type in a closed union", input: { shut: { $type: "test.other.thing#x" } }, ours: "refuse" },
  { what: "a reference to another lexicon", input: { shared: { kind: "c" } }, ours: "accept" },
  { what: "a reference that breaks its definition", input: { shared: { kind: "d" } }, ours: "refuse" },
  { what: "a blob within accept and maxSize", input: { file: BLOB }, ours: "accept" },
  { what: "a blob that accept's exact type allows", input: { file: { ...BLOB, mimeType: "text/plain" } }, ours: "accept" },
  { what: "a blob type accept doesn't allow", input: { file: { ...BLOB, mimeType: "video/mp4" } }, ours: "refuse", theirs: "accept", why: "it leaves accept to upload" },
  { what: "a blob over maxSize", input: { file: { ...BLOB, size: 11 } }, ours: "refuse", theirs: "accept", why: "it leaves maxSize to upload" },
  { what: "a blob type an exact list doesn't name", input: { picture: { ...BLOB, mimeType: "image/jpeg" } }, ours: "refuse", theirs: "accept", why: "it leaves accept to upload" },
  { what: "any MIME type where accept is absent", input: { any: { ...BLOB, mimeType: "application/octet-stream", size: 1_000_000 } }, ours: "accept" },
  { what: "a blob with a field blobs don't have", input: { file: { ...BLOB, name: "picture.png" } }, ours: "refuse" },
  { what: "a blob named by something other than a CID", input: { file: { ...BLOB, ref: { $link: "picture" } } }, ours: "refuse" },
  { what: "a field the method doesn't declare", input: { extra: true }, ours: "accept" },
];

test("generated validators read Lexicon as the reference validator does, except where the spec asks more", async (context) => {
  for (const { what, input, ours, theirs = ours, why } of INPUT_CASES) {
    await context.test(what, () => {
      const value = { bytes: "ab", ...input };
      assert.equal(verdict(generated.thingInputSchema, value), ours, "generated");
      assert.equal(reference(() => official.assertValidXrpcInput("test.fixture.thing", jsonToLex(value))), theirs, why ?? "reference");
    });
  }
});

test("a method's output and parameters, and a record, read the same way", () => {
  assert.equal(verdict(generated.thingOutputSchema, { n: 1 }), "accept");
  assert.equal(verdict(generated.thingOutputSchema, { n: "1" }), "refuse");
  // Lexicon objects are open, so a field a later version adds is read away rather than refused.
  assert.deepEqual(generated.thingOutputSchema.parse({ n: 1, extra: true }), { n: 1 });
  assert.deepEqual(generated.thingInputSchema.parse({ bytes: "ab", extra: true, shared: { kind: "c", extra: true } }), { bytes: "ab", shared: { kind: "c" } });
  assert.equal(reference(() => official.assertValidXrpcOutput("test.fixture.thing", { n: 1, extra: true })), "accept");

  for (const [params, expected] of [[{ q: "abcdefgh" }, "accept"], [{ q: "ééééé" }, "refuse"], [{}, "refuse"]]) {
    assert.equal(verdict(generated.commonParamsSchema, params), expected, JSON.stringify(params));
    assert.equal(reference(() => official.assertValidXrpcParams("test.fixture.common", params)), expected, JSON.stringify(params));
  }

  // Records come from any Ship, so what a later version adds is ignored rather than refused.
  const note = { $type: "test.fixture.note", text: "abc", embed: { alt: "a", later: 1 }, later: 1 };
  assert.deepEqual(generated.shipNoteRecordSchema.parse(note), { $type: "test.fixture.note", text: "abc", embed: { alt: "a" } });
  assert.equal(reference(() => official.assertValidRecord("test.fixture.note", note)), "accept");
  for (const record of [{ ...note, text: "abcd" }, { ...note, $type: "test.fixture.thing" }, { text: "abc" }]) {
    assert.equal(verdict(generated.shipNoteRecordSchema, record), "refuse", JSON.stringify(record));
    assert.equal(reference(() => official.assertValidRecord("test.fixture.note", record)), "refuse", JSON.stringify(record));
  }
});

test("each lexicon names its constants, and a record its collection and literal key", () => {
  assert.equal(generated.THING, "test.fixture.thing");
  assert.equal(generated.COMMON, "test.fixture.common");
  assert.equal(generated.SHIP_NOTE_COLLECTION, "test.fixture.note");
  assert.equal("SHIP_NOTE_RKEY" in generated, false);
  assert.deepEqual(generated.THING_FILE_MIME_TYPES, ["image/*", "text/plain"]);
  assert.equal(generated.THING_FILE_MAX_BYTES, 10);
  assert.deepEqual(generated.THING_PICTURE_MIME_TYPES, ["image/png"]);
  assert.equal("THING_PICTURE_MAX_BYTES" in generated, false);
});

test("a named limit and a rule's constant are exported, and the schemas check against them", async () => {
  const input = "test.fixture.thing#main.input";
  const source = generateShipLexicons(FIXTURES.map(file), {
    rules: { [input]: { maybe: { check: ["z.maxLength(MAX_MAYBE)"], why: "A rule that uses a constant." } } },
    limits: { MAX_BYTES: `${input} bytes`, MAX_COUNT: `${input} count`, MAX_TAGS: `${input} tags` },
    constants: { MAX_MAYBE: 5 },
  });
  for (const check of ["utf8MaxLength(MAX_BYTES)", "z.lte(MAX_COUNT)", "z.maxLength(MAX_TAGS)", "z.maxLength(MAX_MAYBE)"]) {
    assert.ok(source.includes(check), check);
  }
  const named = await load(source);
  assert.deepEqual([named.MAX_BYTES, named.MAX_COUNT, named.MAX_TAGS, named.MAX_MAYBE], [4, 3, 2, 5]);
  const cases = [
    [{ bytes: "éé" }, "accept"], [{ bytes: "ééé" }, "refuse"], [{ count: 3 }, "accept"], [{ count: 4 }, "refuse"],
    [{ tags: ["a", "b"] }, "accept"], [{ tags: ["a", "b", "c"] }, "refuse"], [{ maybe: "abcde" }, "accept"], [{ maybe: "abcdef" }, "refuse"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(verdict(named.thingInputSchema, { bytes: "ab", ...input }), expected, JSON.stringify(input));
  }
});

test("generated types type-check against their schemas", () => {
  const diagnostics = typeCheck(fixtureSource);
  assert.deepEqual(diagnostics, []);
});

test("the generator refuses what it can't map", () => {
  const object = (properties) => procedure({ type: "object", properties });
  const one = (defs) => [file(fixture("test.fixture.thing", defs))];
  const cases = [
    ["a string format it doesn't map", one({ main: object({ link: { type: "string", format: "uri" } }) }), {}, /format/],
    ["a type it doesn't map", one({ main: object({ bytes: { type: "bytes" } }) }), {}, /No matching discriminator/],
    ["a default", one({ main: object({ count: { type: "integer", default: 1 } }) }), {}, /default/],
    ["a parameter that isn't a string", one({
      main: { type: "query", parameters: { type: "params", properties: { limit: { type: "integer" } } } },
    }), {}, /string/],
    ["a path that doesn't name its lexicon", [{ path: "test/fixture/other.json", document: fixture("test.fixture.thing", { main: object({}) }) }], {}, /must hold the lexicon its path names/],
    ["a lexicon without a method or record", one({ main: { type: "object", properties: {} } }), {}, /needs a main query, procedure or record/],
    ["an input without a JSON schema", one({ main: { type: "procedure", input: { encoding: "*/*" } } }), {}, /an input without a JSON schema/],
    ["a nested object", one({ main: object({ inner: { type: "object", properties: {} } }) }), {}, /name a nested object as a definition/],
    ["a required field it doesn't declare", one({ main: procedure({ type: "object", required: ["name"], properties: {} }) }), {}, /lists name, which it doesn't declare/],
    ["an error name that isn't one word in PascalCase", one({ main: { ...object({}), errors: [{ name: "not-found" }] } }), {}, /errors/],
    ["an error declared twice", one({ main: { ...object({}), errors: [{ name: "Gone" }, { name: "Gone" }] } }), {}, /declares the error Gone twice/],
    ["a reference that resolves to nothing", one({ main: object({ thing: { type: "ref", ref: "#missing" } }) }), {}, /unresolved reference #missing/],
    ["a union member that isn't an object", one({
      main: object({ either: { type: "union", refs: ["#name"] } }), name: { type: "string" },
    }), {}, /union member #name must be an object/],
    ["definitions that refer to each other", one({
      main: object({ a: { type: "ref", ref: "#a" } }),
      a: { type: "object", properties: { b: { type: "ref", ref: "#b" } } },
      b: { type: "object", properties: { a: { type: "ref", ref: "#a" } } },
    }), {}, /refer to each other/],
    ["two lexicons generating one name", [file(fixture("test.one.thing", { main: object({}) })), file(fixture("test.two.thing", { main: object({}) }))], {}, /both generate THING/],
    ["a rule for an object no lexicon has", one({ main: object({}) }), { rules: { "test.fixture.missing#main.input": { name: { check: ["z.maxLength(1)"], why: "x" } } } }, /names nothing in the lexicons/],
    ["a rule for a field the lexicon doesn't declare", one({ main: object({}) }), { rules: { "test.fixture.thing#main.input": { name: { check: ["z.maxLength(1)"], why: "x" } } } }, /names a field the lexicon doesn't declare/],
    ["a rule adding a field the lexicon declares", one({ main: object({ name: { type: "string" } }) }), { rules: { "test.fixture.thing#main.input": { name: { add: { type: "string", schema: "z.string()" }, why: "x" } } } }, /a rule adds only a field Lexicon can't declare/],
    ["a kind union on a field that isn't unknown", one({ main: object({ name: { type: "string" } }) }), { rules: { "test.fixture.thing#main.input": { name: { kindUnion: ["#a"], name: "payload", why: "x" } } } }, /must be unknown to hold a kind union/],
    ["a limit for a field the lexicon doesn't declare", one({ main: object({}) }), { limits: { MAX_NAME: "test.fixture.thing#main.input name" } }, /MAX_NAME names test.fixture.thing#main.input name, which isn't/],
    ["a limit for a field without a maximum", one({ main: object({ flag: { type: "boolean" } }) }), { limits: { MAX_FLAG: "test.fixture.thing#main.input flag" } }, /MAX_FLAG names test.fixture.thing#main.input flag, which isn't/],
    ["two names for one limit", one({ main: object({ name: { type: "string", maxLength: 1 } }) }), { limits: { MAX_A: "test.fixture.thing#main.input name", MAX_B: "test.fixture.thing#main.input name" } }, /MAX_A and MAX_B both name the limit/],
    ["a limit named as a lexicon is", one({ main: object({ name: { type: "string", maxLength: 1 } }) }), { limits: { THING: "test.fixture.thing#main.input name" } }, /both generate THING/],
    ["a constant no rule uses", one({ main: object({}) }), { constants: { MAX_UNUSED: 1 } }, /No rule uses MAX_UNUSED/],
  ];
  for (const [what, files, options, message] of cases) {
    assert.throws(() => generateShipLexicons(files, options), message, what);
  }
});

test("the check finds space.ship NSIDs written into code, but not in comments, messages or exempt files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "gsv-ship-nsids-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "src/constant.ts": 'export const PROFILE = "space.ship.profile";\n',
    "src/template.mjs": "export const deliver = `space.ship.deliver`;\n",
    "src/definition.ts": '\n\nexport const message = { $type: "space.ship.deliver#message" };\n',
    "src/comment.ts": "// space.ship.profile is a record.\n/** Calls `space.ship.deliver`. */\nexport const value = 1;\n",
    "src/message.ts": 'export const message = "a record such as space.ship.profile";\n',
    "src/generated/ship.ts": 'export const PROFILE = "space.ship.profile";\n',
    "src/profile.test.ts": 'export const PROFILE = "space.ship.profile";\n',
    "test-integration/profile.ts": 'export const PROFILE = "space.ship.profile";\n',
    "src/kernel/schema/v075_profiles.ts": 'export const PROFILE = "space.ship.profile";\n',
    "ignored.ts": 'export const PROFILE = "space.ship.profile";\n',
    ".gitignore": "ignored.ts\n",
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  assert.deepEqual(findShipNsidLiterals(root).sort(), [
    "src/constant.ts:1 space.ship.profile",
    "src/definition.ts:3 space.ship.deliver#message",
    "src/template.mjs:1 space.ship.deliver",
  ]);
});

test("format checks agree with atcute's syntax checks", () => {
  const corpus = {
    did: [isDid, generated.isDid, [
      ALICE, "did:web:example.com", "did:web:localhost%3A8080", "did:method:a:b", "did:a:b", "did:", "did:PLC:abc",
      "did:plc:", "did:plc:abc:", "did:plc:abc%", "DID:plc:abc", "did:plc:ab cd", `did:plc:${"a".repeat(2_041)}`, `did:plc:${"a".repeat(2_040)}`,
    ]],
    handle: [isHandle, generated.isHandle, [
      "alice.ship.space", "a.co", "xn--ls8h.test", "ALICE.Ship.Space", "alice", "-alice.ship.space", "alice-.ship.space",
      "alice.ship.space.", "alice..ship", `${"a".repeat(64)}.com`, `${"a".repeat(63)}.com`, "alice.123", "a_b.com",
      `${"a.".repeat(125)}co`, `${"a.".repeat(126)}co`,
    ]],
    "at-uri": [isResourceUri, generated.isAtUri, [
      `at://${ALICE}`, `at://${ALICE}/test.fixture.note`, `at://${ALICE}/test.fixture.note/self`, "at://alice.ship.space/test.fixture.note/3jzfcijpj2z2a",
      `at://${ALICE}/test.fixture.note/self#/text`, "at://alice", `at://${ALICE}/notansid`, `at://${ALICE}/test.fixture.note/..`,
      `at://${ALICE}/test.fixture.note/self/extra`, "https://alice.ship.space", `at://${ALICE}/`,
    ]],
    datetime: [isDatetime, generated.isDatetime, [
      "2026-10-25T12:00:00Z", "2026-10-25T12:00:00.123456Z", "2026-10-25T12:00:00+01:00", "2026-10-25T12:00:00-00:00",
      "2026-10-25T12:00:00", "2026-10-25", "0000-01-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-25t12:00:00z",
      "2026-10-25T24:00:00Z", " 2026-10-25T12:00:00Z",
    ]],
    cid: [isCid, generated.isCid, [
      RAW_CID, DAG_CBOR_CID, V0_CID, DAG_PB_CID, "bafkreaa", RAW_CID.toUpperCase(), RAW_CID.slice(0, -1), `${RAW_CID}a`, "",
    ]],
  };
  for (const [format, [atcute, ours, values]] of Object.entries(corpus)) {
    for (const value of values) assert.equal(ours(value), atcute(value), `${format} ${value}`);
  }
});

/** The lexicon as @atproto/lexicon's schemas read it, which refuses an invalid one and drops keys they don't know. */
function officialRoundTrip(document) {
  lexiconDoc.parse(document);
  const defs = Object.entries(document.defs).map(([name, definition]) => [name, OFFICIAL_DEFINITIONS[definition.type].parse(definition)]);
  return { ...document, defs: Object.fromEntries(defs) };
}

function fixture(id, defs) {
  return { lexicon: 1, id, defs };
}

function procedure(schema) {
  return { type: "procedure", input: { encoding: "application/json", schema } };
}

function file(document) {
  return { path: `${document.id.split(".").join("/")}.json`, document };
}

function verdict(schema, value) {
  return schema.safeParse(value).success ? "accept" : "refuse";
}

function reference(validate) {
  try {
    validate();
    return "accept";
  } catch {
    return "refuse";
  }
}

/** Every reference a lexicon's definitions make, as written. */
function references(definition) {
  if (Array.isArray(definition)) return definition.flatMap(references);
  if (definition?.constructor !== Object) return [];
  const own = definition.type === "ref" ? [definition.ref] : definition.type === "union" ? definition.refs : [];
  return [...own, ...Object.values(definition).flatMap(references)];
}

/** The module, bundled beside the real generated one so its imports resolve, with the format checks it imports. */
async function load(source) {
  const { outputFiles } = await build({
    stdin: {
      contents: `${source}\nexport { isAtUri, isCid, isDatetime, isDid, isHandle } from "../lexicon";\n`,
      loader: "ts",
      resolveDir: generatedDirectory,
    },
    bundle: true,
    format: "esm",
    logLevel: "silent",
    platform: "node",
    write: false,
  });
  return await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}

/** Diagnostics for the module as if it sat beside the real generated one, under the SDK's compiler options. */
function typeCheck(source) {
  const config = ts.getParsedCommandLineOfConfigFile(join(repositoryRoot, "packages", "gsv", "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  });
  const path = join(generatedDirectory, "fixture-lexicons.ts");
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => name === path ? ts.createSourceFile(name, source, version) : getSourceFile(name, version);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === path || fileExists(name);
  const program = ts.createProgram([path], { ...config.options, noEmit: true }, host);
  const sourceFile = program.getSourceFile(path);
  return [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
