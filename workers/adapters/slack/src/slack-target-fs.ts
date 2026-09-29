import { posix } from "node:path";
import {
  getSlackConversation,
  getSlackConversationHistory,
  getSlackConversationReplies,
  getSlackUser,
  listSlackConversations,
  listSlackUsers,
  type SlackConversationSummary,
  type SlackFetch,
  type SlackMessageSummary,
  type SlackPage,
  type SlackUserSummary,
} from "./slack-api";

export type SlackTargetReader = {
  userToken: string;
  actorId: string;
  teamId: string;
  teamName?: string;
  signal: AbortSignal;
  slackFetch: SlackFetch;
  guard: () => Promise<void>;
};

export type SlackResource =
  | { kind: "file"; text: string; contentType: string }
  | { kind: "directory"; list: () => Promise<DirectoryEntries> };

type DirectoryEntries = { files: string[]; directories: string[] };

type MessageView = {
  channel: string;
  thread?: string;
  cursor?: string;
  root: string;
  path: string;
};

const ID = "[A-Z][A-Z0-9]{1,31}";
const TS = "[0-9]{1,16}\\.[0-9]{1,16}";
const MESSAGE_PAGE_SIZE = 15;
const COLLECTION_PAGE_SIZE = 200;
const MAX_DIRECTORY_PAGES = 8;
const MAX_PROVIDER_REQUESTS = 32;
const MAX_SLACK_RESOURCE_BYTES = 4 * 1024 * 1024;
const MAX_RENDERED_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

const README = `GSV Slack filesystem

These are live, read-only resources visible to the paired Slack user.
Use Read or cat on /conversations/index.json and /users/index.json to discover
IDs, names, resource paths, and nextPath for another inventory page.

/workspace.json
/conversations/<id>/meta.json
/conversations/<id>/history/recent/index.json
/conversations/<id>/history/recent/transcript.txt
/conversations/<id>/messages/<timestamp>.json
/conversations/<id>/threads/<root-timestamp>/index.json
/conversations/<id>/threads/<root-timestamp>/transcript.txt
/conversations/<id>/threads/<root-timestamp>/messages/<reply-timestamp>.json
/users/<id>.json

History and thread views contain at most 15 messages per Slack page. index.json
and the transcript header report coverage, whether more messages exist, provider
history restrictions, and nextPath. Follow nextPath explicitly. Cursors expire;
restart at the first page if Slack rejects one. Message paths use stable IDs and
timestamps; their contents can change when Slack messages are edited or deleted.
History pages contain channel messages; follow threadPath for replies.

Search accepts an individual file or a history page directory. It matches literal
text in those files, with optional include globs, and never crawls a workspace.
Directory inventories are complete or fail with guidance to use paginated indexes.
Message and thread collections are discovered through history/index files.

The same resources are available in shell.exec. /tmp is writable scratch space
for that execution only. Use slack --help for explicit posting and reaction
commands. Filesystem writes never post, edit, or delete Slack messages.
File references and attachment downloads are not provided by this live view.
`;

/** One invocation owns its resource cache and provider requests. */
export class SlackTargetFileSystem {
  private readonly resources = new Map<string, Promise<SlackResource>>();
  private readonly pages = new Map<string, Promise<SlackPage<SlackMessageSummary>>>();
  private readonly conversations = new Map<string, Promise<SlackConversationSummary>>();
  private requests = 0;
  private renderedBytes = 0;

  constructor(private readonly reader: SlackTargetReader) {}

  async get(inputPath: string): Promise<SlackResource> {
    const path = normalizeSlackPath(inputPath);
    this.reader.signal.throwIfAborted();
    await this.reader.guard();
    let resource = this.resources.get(path);
    if (!resource) {
      resource = this.resolve(path).then((value) => {
        if (value.kind === "file") {
          this.renderedBytes += encoder.encode(value.text).byteLength;
          if (this.renderedBytes > MAX_RENDERED_BYTES) {
            throw new Error("Slack filesystem cache limit reached; read fewer resources per invocation");
          }
        }
        return value;
      });
      this.resources.set(path, resource);
    }
    const result = await resource;
    this.reader.signal.throwIfAborted();
    await this.reader.guard();
    return result;
  }

  async searchFiles(inputPath: string): Promise<string[]> {
    const path = normalizeSlackPath(inputPath);
    // Only finite page directories are searchable; their continuation links are
    // data in index.json, not silently omitted descendant files.
    if (!isMessagePageDirectory(path) && !path.endsWith(".json") && !path.endsWith(".txt")) {
      throw new Error("Search a Slack file or history page directory, such as /conversations/<id>/history/recent; workspace-wide filesystem search is unavailable");
    }
    const resource = await this.get(path);
    if (resource.kind === "file") return [path];
    return (await resource.list()).files.map((name) => `${path}/${name}`);
  }

  private async resolve(path: string): Promise<SlackResource> {
    if (path === "/") return directory(["README.txt", "workspace.json"], ["conversations", "users"]);
    if (path === "/README.txt") return textFile(README);
    if (path === "/workspace.json") return jsonFile({
      id: this.reader.teamId,
      name: this.reader.teamName,
      reader: this.reader.actorId,
      readOnly: true,
    });

    const collection = path.match(/^\/(conversations|users)(?:\/(index\.json|pages(?:\/([^/]+)\.json)?))?$/);
    if (collection) {
      const kind = collection[1] === "users" ? "users" : "conversations";
      if (!collection[2]) return { kind: "directory", list: () => this.listCollection(kind) };
      if (collection[2] === "pages") {
        return indexedDirectory(`Read /${kind}/index.json and follow nextPath to browse inventory pages`);
      }
      const page = await this.collectionPage(kind, collection[3] ? decodeCursor(collection[3]) : undefined);
      return jsonFile({
        items: page.items.map((item) => ({ ...item, path: kind === "users" ? `/users/${item.id}.json` : `/conversations/${item.id}` })),
        hasMore: Boolean(page.nextCursor),
        nextPath: page.nextCursor ? `/${kind}/pages/${encodeCursor(page.nextCursor)}.json` : null,
      });
    }

    const user = path.match(new RegExp(`^/users/(${ID})\\.json$`));
    if (user) return jsonFile(await this.request((fetcher) => getSlackUser(this.reader.userToken, user[1], fetcher)));

    const conversation = path.match(new RegExp(`^/conversations/(${ID})(?:/(.*))?$`));
    if (!conversation) throw missing(path);
    const channel = conversation[1];
    const suffix = conversation[2] ?? "";
    const metadata = await this.conversation(channel);
    if (!suffix) return directory(["meta.json"], ["history", "messages", "threads"]);
    if (suffix === "meta.json") return jsonFile(metadata);
    if (suffix === "history") return directory([], ["recent", "pages"]);
    if (suffix === "messages" || suffix === "threads" || suffix === "history/pages") {
      return indexedDirectory(`Read /conversations/${channel}/history/recent/index.json for message, thread, and continuation paths`);
    }

    const message = suffix.match(new RegExp(`^messages/(${TS})\\.json$`));
    if (message) return await this.message(channel, message[1]);

    const threadMessage = suffix.match(new RegExp(`^threads/(${TS})/messages/(${TS})\\.json$`));
    if (threadMessage) return await this.message(channel, threadMessage[2], threadMessage[1]);
    const threadCollection = suffix.match(new RegExp(`^threads/(${TS})/(messages|pages)$`));
    if (threadCollection) {
      return indexedDirectory(`Read /conversations/${channel}/threads/${threadCollection[1]}/index.json for reply and continuation paths`);
    }

    const view = parseMessageView(path);
    if (!view) throw missing(path);
    const page = await this.messagePage(view);
    if (path === view.path) {
      const directories = view.thread && !view.cursor ? ["messages", "pages"] : [];
      return directory(["index.json", "transcript.txt"], directories);
    }
    const nextPath = page.nextCursor ? `${view.root}/pages/${encodeCursor(page.nextCursor)}` : null;
    const coverage = {
      channel,
      thread: view.thread ?? null,
      scope: "page",
      order: view.thread ? "oldest-first" : "newest-first",
      limit: MESSAGE_PAGE_SIZE,
      count: page.items.length,
      hasMore: Boolean(page.nextCursor || page.hasMore),
      isLimited: page.isLimited === true,
      nextPath,
    };
    if (path.endsWith("/index.json")) {
      return jsonFile({
        ...coverage,
        items: page.items.map((item) => ({
          ...item,
          path: messagePath(channel, item, view.thread),
          threadPath: item.threadTs || item.replyCount
            ? `/conversations/${channel}/threads/${item.threadTs ?? item.ts}`
            : undefined,
        })),
      });
    }
    if (path.endsWith("/transcript.txt")) {
      const lines = [
        `Slack ${view.thread ? `thread ${view.thread}` : "history"} in ${channel}`,
        `Coverage: one page, ${coverage.count} messages, ${coverage.order}`,
        `More messages: ${coverage.hasMore ? "yes" : "no"}; provider history limited: ${coverage.isLimited ? "yes" : "no"}`,
        `Next page: ${nextPath ?? (coverage.hasMore ? "unavailable; restart from the first page" : "none")}`,
        "",
      ];
      for (const item of page.items) {
        lines.push(`[${item.ts}] ${item.userId ?? item.botId ?? "unknown"}`, `Source: ${messagePath(channel, item, view.thread)}`, item.text, "");
      }
      return textFile(lines.join("\n"));
    }
    throw missing(path);
  }

  private async conversation(channel: string): Promise<SlackConversationSummary> {
    let result = this.conversations.get(channel);
    if (!result) {
      result = this.request((fetcher) => getSlackConversation(this.reader.userToken, channel, fetcher));
      this.conversations.set(channel, result);
    }
    return await result;
  }

  private async collectionPage(kind: "conversations" | "users", cursor?: string): Promise<SlackPage<SlackConversationSummary | SlackUserSummary>> {
    return await this.request(async (fetcher) => kind === "conversations"
      ? await listSlackConversations(this.reader.userToken, {
        types: "public_channel,private_channel,mpim,im",
        limit: COLLECTION_PAGE_SIZE,
        cursor,
      }, fetcher)
      : await listSlackUsers(this.reader.userToken, { limit: COLLECTION_PAGE_SIZE, cursor }, fetcher));
  }

  private async listCollection(kind: "conversations" | "users"): Promise<DirectoryEntries> {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let count = 0; count < MAX_DIRECTORY_PAGES; count += 1) {
      const page = await this.collectionPage(kind, cursor);
      for (const item of page.items) ids.add(item.id);
      if (!page.nextCursor) return kind === "conversations"
        ? { files: ["index.json"], directories: ["pages", ...ids].sort() }
        : { files: ["index.json", ...[...ids].map((id) => `${id}.json`)].sort(), directories: ["pages"] };
      if (cursors.has(page.nextCursor)) break;
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`Slack directory is too large to enumerate; read /${kind}/index.json and follow nextPath`);
  }

  private async messagePage(view: MessageView): Promise<SlackPage<SlackMessageSummary>> {
    let result = this.pages.get(view.path);
    if (!result) {
      result = this.request(async (fetcher) => {
        const args = { channel: view.channel, limit: MESSAGE_PAGE_SIZE, cursor: view.cursor };
        return view.thread
          ? await getSlackConversationReplies(this.reader.userToken, { ...args, timestamp: view.thread }, fetcher)
          : await getSlackConversationHistory(this.reader.userToken, args, fetcher);
      });
      this.pages.set(view.path, result);
    }
    return await result;
  }

  private async message(channel: string, timestamp: string, thread?: string): Promise<SlackResource> {
    const page = await this.request(async (fetcher) => {
      const args = { channel, oldest: timestamp, latest: timestamp, inclusive: true, limit: 1 };
      return thread
        ? await getSlackConversationReplies(this.reader.userToken, { ...args, timestamp: thread }, fetcher)
        : await getSlackConversationHistory(this.reader.userToken, args, fetcher);
    });
    const message = page.items.find((item) => item.ts === timestamp);
    if (!message) throw new Error("No such Slack message, or it is no longer visible");
    return jsonFile(message);
  }

  private async request<T>(operation: (fetcher: SlackFetch) => Promise<T>): Promise<T> {
    this.reader.signal.throwIfAborted();
    await this.reader.guard();
    if (++this.requests > MAX_PROVIDER_REQUESTS) {
      throw new Error("Slack filesystem request limit reached; select a narrower resource or page");
    }
    const result = await operation((input, init) => this.reader.slackFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, this.reader.signal]) : this.reader.signal,
    }));
    this.reader.signal.throwIfAborted();
    await this.reader.guard();
    return result;
  }
}

export function normalizeSlackPath(path: string): string {
  if (!path || path.includes("\0") || path.length > 4_096) throw new Error("Slack filesystem path is invalid");
  return posix.resolve("/", path);
}

function directory(files: string[], directories: string[]): SlackResource {
  return { kind: "directory", list: async () => ({ files: files.sort(), directories: directories.sort() }) };
}

function indexedDirectory(guidance: string): SlackResource {
  return { kind: "directory", list: async () => { throw new Error(guidance); } };
}

function textFile(text: string, contentType = "text/plain; charset=utf-8"): SlackResource {
  if (encoder.encode(text).byteLength > MAX_SLACK_RESOURCE_BYTES) throw new Error("Slack resource exceeds the file size limit");
  return { kind: "file", text, contentType };
}

function jsonFile<T extends object>(value: T): SlackResource {
  return textFile(`${JSON.stringify(value, null, 2)}\n`, "application/json; charset=utf-8");
}

function missing(path: string): Error {
  return new Error(`No such Slack resource: ${path}`);
}

function encodeCursor(cursor: string): string {
  return btoa(cursor).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(segment: string): string {
  if (!/^[A-Za-z0-9_-]{1,2731}$/.test(segment)) throw new Error("Slack page cursor is invalid");
  const cursor = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  if (encodeCursor(cursor) !== segment || cursor.length > 2_048) throw new Error("Slack page cursor is invalid");
  return cursor;
}

function parseMessageView(path: string): MessageView | null {
  const history = path.match(new RegExp(`^(/conversations/(${ID})/history)/(recent|pages/([^/]+))(?:/(index\\.json|transcript\\.txt))?$`));
  if (history) return {
    channel: history[2], root: history[1], path: `${history[1]}/${history[3]}`,
    cursor: history[4] ? decodeCursor(history[4]) : undefined,
  };
  const thread = path.match(new RegExp(`^(/conversations/(${ID})/threads/(${TS}))(?:/pages/([^/]+))?(?:/(index\\.json|transcript\\.txt))?$`));
  if (!thread) return null;
  return {
    channel: thread[2], thread: thread[3], root: thread[1],
    path: thread[4] ? `${thread[1]}/pages/${thread[4]}` : thread[1],
    cursor: thread[4] ? decodeCursor(thread[4]) : undefined,
  };
}

function isMessagePageDirectory(path: string): boolean {
  const view = parseMessageView(path);
  return view !== null && path === view.path && (!view.thread || view.cursor !== undefined);
}

function messagePath(channel: string, message: SlackMessageSummary, thread?: string): string {
  const root = thread ?? message.threadTs;
  return root && root !== message.ts
    ? `/conversations/${channel}/threads/${root}/messages/${message.ts}.json`
    : `/conversations/${channel}/messages/${message.ts}.json`;
}
