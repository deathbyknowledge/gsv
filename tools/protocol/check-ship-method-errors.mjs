import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readLexiconFiles } from "./generate-ship-lexicons.mjs";

/**
 * Check that every XRPC error a Ship method can answer with is one its lexicon
 * declares, or one any XRPC method may answer with. Each handler the Gateway
 * registers in kernel/ships/methods.ts is walked through every call the type
 * checker resolves into Gateway source, and what it throws is named as
 * kernel/ships/xrpc.ts's failure() names it: a ShipXrpcError by its own name, a
 * PublicFederationError by its status, an ApproachAdmissionError by its reason,
 * and the other errors failure() answers for by the name it gives them.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATEWAY = "workers/gateway";
const METHODS = `${GATEWAY}/src/kernel/ships/methods.ts`;
const XRPC = `${GATEWAY}/src/kernel/ships/xrpc.ts`;

/**
 * Errors any XRPC method may answer with, so no lexicon declares them: XRPC's
 * own, and those service auth answers with when a call's token doesn't verify.
 */
const GENERIC_ERRORS = new Set([
  "InvalidRequest", "AuthenticationRequired", "Forbidden", "XRPCNotSupported", "NotAcceptable", "PayloadTooLarge",
  "UnsupportedMediaType", "RateLimitExceeded", "InternalServerError", "MethodNotImplemented", "UpstreamFailure",
  "NotEnoughResources", "UpstreamTimeout",
  "AuthMissing", "BadJwt", "BadJwtAudience", "BadJwtLexiconMethod", "BadJwtSignature", "JwtExpired",
]);

/**
 * Each problem as `nsid answers Name (file:line), which its lexicon doesn't
 * declare`. `overrides` replaces Gateway sources by path, for tests.
 */
export function checkShipMethodErrors({ root = repositoryRoot, overrides = {} } = {}) {
  const program = gatewayProgram(root, overrides);
  const checker = program.getTypeChecker();
  const failure = readFailure(program.getSourceFile(join(root, XRPC)));
  const lexicons = new Map(readLexiconFiles(join(root, "lexicons")).map(({ document }) => [document.id, document]));
  const problems = [];
  for (const { nsid, handler } of shipMethods(program, checker, root, lexicons)) {
    const declared = new Set((lexicons.get(nsid).defs.main.errors ?? []).map((error) => error.name));
    for (const [name, where] of answeredErrors(handler, checker, failure, root, problems)) {
      if (!GENERIC_ERRORS.has(name) && !declared.has(name)) problems.push(`${nsid} answers ${name} (${where}), which its lexicon doesn't declare`);
    }
  }
  return problems;
}

function gatewayProgram(root, overrides) {
  const directory = join(root, GATEWAY);
  const configPath = join(directory, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory, undefined, configPath);
  const replaced = new Map(Object.entries(overrides).map(([path, text]) => [join(root, path), text]));
  const host = ts.createCompilerHost(parsed.options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, ...rest) => replaced.has(fileName)
    ? ts.createSourceFile(fileName, replaced.get(fileName), language, true)
    : getSourceFile(fileName, language, ...rest);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => replaced.get(fileName) ?? readFile(fileName);
  return ts.createProgram(parsed.fileNames, parsed.options, host);
}

/** The methods SHIP_METHODS registers, each with the declaration of its handler. */
function shipMethods(program, checker, root, lexicons) {
  const nsids = new Map([...lexicons.keys()].map((nsid) => [screaming(nsid.split(".").at(-1)), nsid]));
  const source = program.getSourceFile(join(root, METHODS));
  const registry = findVariable(source, "SHIP_METHODS")?.initializer;
  const entries = registry && ts.isNewExpression(registry) ? registry.arguments?.[0] : undefined;
  if (!entries || !ts.isArrayLiteralExpression(entries)) throw new Error(`Can't read SHIP_METHODS in ${METHODS}`);
  return entries.elements.map((entry) => {
    const [key, method] = ts.isArrayLiteralExpression(entry) ? entry.elements : [];
    const handle = method && ts.isObjectLiteralExpression(method)
      ? method.properties.find((property) => property.name?.getText() === "handle")
      : undefined;
    const nsid = key && nsids.get(key.getText());
    if (!nsid || !handle || !ts.isPropertyAssignment(handle)) throw new Error(`Can't read the method ${entry.getText()} in ${METHODS}`);
    const handler = declarationOf(checker, handle.initializer);
    if (!handler) throw new Error(`Can't find the handler of ${nsid}`);
    return { nsid, handler };
  });
}

/** What failure() answers for each error it names, read from its source. */
function readFailure(source) {
  const statuses = new Map();
  const table = findVariable(source, "ERRORS_BY_STATUS")?.initializer;
  for (const pair of table && ts.isNewExpression(table) && table.arguments?.[0] && ts.isArrayLiteralExpression(table.arguments[0]) ? table.arguments[0].elements : []) {
    const [status, name] = ts.isArrayLiteralExpression(pair) ? pair.elements : [];
    if (status && name && ts.isNumericLiteral(status) && ts.isStringLiteral(name)) statuses.set(Number(status.text), name.text);
  }
  const reasons = new Map();
  let otherReasons;
  for (const statement of findFunction(source, "approachRefusal")?.body?.statements ?? []) {
    if (ts.isIfStatement(statement)) {
      const reason = statement.expression;
      const name = errorNameOf(returned(statement.thenStatement));
      if (ts.isBinaryExpression(reason) && ts.isStringLiteral(reason.right) && name) reasons.set(reason.right.text, name);
    } else if (ts.isReturnStatement(statement)) {
      otherReasons = errorNameOf(statement.expression);
    }
  }
  const classes = new Map();
  for (const statement of findFunction(source, "failure")?.body?.statements ?? []) {
    if (!ts.isIfStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
    if (statement.expression.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) continue;
    const answer = returned(statement.thenStatement);
    const name = answer && ts.isCallExpression(answer) ? errorNameOf(answer.arguments[0]) : undefined;
    if (name) classes.set(statement.expression.right.getText(), name);
  }
  if (statuses.size === 0 || reasons.size === 0 || !otherReasons) throw new Error(`Can't read how failure() names errors in ${XRPC}`);
  return { statuses, reasons, otherReasons, classes };
}

/** Each XRPC error the handler can answer with, and one place that throws it. */
function answeredErrors(handler, checker, failure, root, problems) {
  const gatewaySource = join(root, GATEWAY, "src") + "/";
  const found = new Map();
  const visited = new Set();
  const answer = (name, node) => {
    if (!found.has(name)) found.set(name, where(node));
  };
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const type = node.expression.getText();
      const [first, second] = node.arguments ?? [];
      if (type === "ShipXrpcError") {
        if (second && ts.isStringLiteralLike(second)) answer(second.text, node);
        else problems.push(`${where(node)} throws a ShipXrpcError whose name isn't a string literal`);
      } else if (type === "PublicFederationError") {
        if (first && ts.isNumericLiteral(first)) answer(failure.statuses.get(Number(first.text)) ?? "InternalServerError", node);
        else problems.push(`${where(node)} throws a PublicFederationError whose status isn't a number literal`);
      } else if (type === "ApproachAdmissionError") {
        if (first && ts.isStringLiteralLike(first)) answer(failure.reasons.get(first.text) ?? failure.otherReasons, node);
        else problems.push(`${where(node)} throws an ApproachAdmissionError whose reason isn't a string literal`);
      } else if (failure.classes.has(type)) {
        answer(failure.classes.get(type), node);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = checker.getResolvedSignature(node)?.declaration;
      const file = target?.getSourceFile().fileName;
      if (target && target.body && file.startsWith(gatewaySource) && !file.endsWith(".test.ts") && !visited.has(target)) {
        visited.add(target);
        visit(target.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visited.add(handler);
  visit(handler.body);
  return found;
}

function declarationOf(checker, expression) {
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (declaration && ts.isVariableDeclaration(declaration)) return declaration.initializer;
  return declaration;
}

function findVariable(source, name) {
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function findFunction(source, name) {
  return source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
}

function returned(statement) {
  if (ts.isReturnStatement(statement)) return statement.expression;
  if (ts.isBlock(statement) && statement.statements.length === 1) return returned(statement.statements[0]);
  return undefined;
}

/** The name in `new ShipXrpcError(status, "Name", ...)`. */
function errorNameOf(expression) {
  if (!expression || !ts.isNewExpression(expression) || expression.expression.getText() !== "ShipXrpcError") return undefined;
  const name = expression.arguments?.[1];
  return name && ts.isStringLiteralLike(name) ? name.text : undefined;
}

function where(node) {
  const source = node.getSourceFile();
  const file = source.fileName.slice(repositoryRoot.length + 1);
  return `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}

function screaming(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkShipMethodErrors();
  if (problems.length > 0) {
    console.error(["Ship methods answer errors their lexicons don't declare. Declare each in its lexicon's errors:", ...problems.map((problem) => `  ${problem}`)].join("\n"));
    process.exitCode = 1;
  }
}
