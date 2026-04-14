import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Wiki",
    description: "Knowledge databases, pages, and inbox review.",
    window: {
      width: 1180,
      height: 800,
      minWidth: 860,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "fs.read",
        "knowledge.db.list",
        "knowledge.db.init",
        "knowledge.list",
        "knowledge.read",
        "knowledge.write",
        "knowledge.search",
        "knowledge.query",
        "knowledge.ingest",
        "knowledge.compile",
        "knowledge.merge",
        "proc.spawn",
        "proc.send",
        "signal.watch",
      ],
    },
  },
  setup: async (ctx) => {
    await ctx.package.sqlExec(`
      create table if not exists wiki_builds (
        pid text primary key,
        db_id text not null,
        db_title text,
        source_target text not null,
        source_path text not null,
        status text not null,
        watch_id text,
        pages_count integer,
        inbox_count integer,
        error text,
        started_at integer not null,
        completed_at integer
      )
    `);
  },
  app: {
    async fetch(request, ctx) {
      const routeBase = ctx.meta.routeBase ?? "/apps/wiki";
      return handleFetch(request, {
        props: {
          appFrame: { packageId: ctx.meta.packageId, routeBase },
          kernel: ctx.kernel,
          package: ctx.package,
        },
        env: { PACKAGE_ROUTE_BASE: routeBase },
      });
    },
    async onSignal(ctx) {
      if (ctx.signal !== "chat.complete") {
        return;
      }

      const state = (ctx.watch.state && typeof ctx.watch.state === "object")
        ? ctx.watch.state as {
            db?: unknown;
            dbTitle?: unknown;
            sourceTarget?: unknown;
            sourcePath?: unknown;
          }
        : {};
      const payload = (ctx.payload && typeof ctx.payload === "object")
        ? ctx.payload as { error?: unknown; aborted?: unknown }
        : {};

      const pid = typeof ctx.sourcePid === "string" ? ctx.sourcePid : "";
      if (!pid) {
        return;
      }

      const db = typeof state.db === "string" ? state.db.trim() : "";
      const dbTitle = typeof state.dbTitle === "string" ? state.dbTitle.trim() : "";
      const sourceTarget = typeof state.sourceTarget === "string" ? state.sourceTarget.trim() : "";
      const sourcePath = typeof state.sourcePath === "string" ? state.sourcePath.trim() : "";
      const completedAt = Date.now();
      const error = typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : payload.aborted === true
          ? "Build aborted"
          : "";

      let pagesCount = null;
      let inboxCount = null;
      if (!error && db) {
        try {
          const pages = await ctx.kernel.request("knowledge.list", {
            prefix: `${db}/pages`,
            recursive: true,
            limit: 1000,
          });
          const inbox = await ctx.kernel.request("knowledge.list", {
            prefix: `${db}/inbox`,
            recursive: true,
            limit: 1000,
          });
          pagesCount = Array.isArray(pages?.entries)
            ? pages.entries.filter((entry) => entry.kind === "file").length
            : null;
          inboxCount = Array.isArray(inbox?.entries)
            ? inbox.entries.filter((entry) => entry.kind === "file").length
            : null;
        } catch {
          pagesCount = null;
          inboxCount = null;
        }
      }

      await ctx.package.sqlExec(
        `insert into wiki_builds (
          pid, db_id, db_title, source_target, source_path, status, watch_id,
          pages_count, inbox_count, error, started_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(pid) do update set
          db_id = excluded.db_id,
          db_title = excluded.db_title,
          source_target = excluded.source_target,
          source_path = excluded.source_path,
          status = excluded.status,
          watch_id = excluded.watch_id,
          pages_count = excluded.pages_count,
          inbox_count = excluded.inbox_count,
          error = excluded.error,
          completed_at = excluded.completed_at`,
        [
          pid,
          db,
          dbTitle || null,
          sourceTarget,
          sourcePath,
          error ? "failed" : "completed",
          ctx.watch.id || null,
          pagesCount,
          inboxCount,
          error || null,
          typeof ctx.watch.createdAt === "number" ? ctx.watch.createdAt : completedAt,
          completedAt,
        ],
      );
    },
  },
});
