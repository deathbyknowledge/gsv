import { readFile } from "node:fs/promises";
import Ajv from "ajv";

const ajv = new Ajv();
const isTelegramMe = ajv.compile({
  type: "object",
  properties: { username: { type: "string", minLength: 1 } },
  required: ["username"],
  additionalProperties: true,
});
const isTelegramWebhookInfo = ajv.compile({
  type: "object",
  properties: { url: { type: "string" } },
  required: ["url"],
  additionalProperties: true,
});

const args = process.argv.slice(2);
const url = option("--url");
const secretsFile = optionalOption("--secrets-file");
const prefix = optionalOption("--prefix") ?? "";
if (!/^[A-Z0-9_]*$/.test(prefix)) {
  throw new Error("Managed Telegram secret prefix is invalid");
}
const fileValues = secretsFile
  ? JSON.parse(await readFile(secretsFile, "utf8"))
  : {};
const token = secret("TELEGRAM_BOT_TOKEN");
const webhookSecret = secret("TELEGRAM_WEBHOOK_SECRET");
const expectedUsername = String(
  fileValues[`${prefix}TELEGRAM_BOT_USERNAME`] ??
    process.env[`${prefix}TELEGRAM_BOT_USERNAME`] ??
    "",
).trim().replace(/^@/, "");

if (!/^https:\/\/[^/]+\/webhook$/.test(url)) {
  throw new Error("Managed Telegram webhook URL must be an HTTPS /webhook URL");
}
if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
  throw new Error("Managed Telegram webhook secret is invalid");
}

const me = await telegram("getMe");
if (!isTelegramMe(me)) {
  throw new Error("Telegram getMe returned an invalid bot identity");
}
const actualUsername = me.username;
if (!actualUsername || (expectedUsername && actualUsername !== expectedUsername)) {
  throw new Error("Managed Telegram bot identity does not match configuration");
}

await telegram("setWebhook", {
  url,
  secret_token: webhookSecret,
  allowed_updates: ["message"],
  drop_pending_updates: false,
});
const webhook = await telegram("getWebhookInfo");
if (!isTelegramWebhookInfo(webhook)) {
  throw new Error("Telegram getWebhookInfo returned an invalid result");
}
if (webhook.url !== url) {
  throw new Error("Telegram did not retain the managed webhook URL");
}

process.stdout.write(`Managed Telegram webhook is ready for @${actualUsername}.\n`);

function option(name) {
  const value = optionalOption(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function secret(name) {
  const key = `${prefix}${name}`;
  const value = String(fileValues[key] ?? process.env[key] ?? "").trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

async function telegram(method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Telegram ${method} request failed`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned invalid JSON`);
  }
  if (!response.ok || payload?.ok !== true || !payload.result) {
    throw new Error(`Telegram ${method} was rejected (${response.status})`);
  }
  return payload.result;
}
