import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { bodyToBytes } from "@humansandmachines/gsv/protocol";
import { createInstallationStorage } from "../installation/storage";
import { testPeer } from "../test-support/peers";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { handleConversationLinkImage, handleConversationLinkPreview } from "./link-preview-handlers";
import {
  LINK_PREVIEW_FAILURE_TTL_MS,
  LINK_PREVIEW_IMAGE_PREFIX,
  LINK_PREVIEW_SUCCESS_TTL_MS,
  LinkPreviewFailure,
  LinkPreviews,
  MAX_LINK_PREVIEW_IMAGE_BYTES,
  MAX_LINK_PREVIEW_PAGE_BYTES,
  previewableUrl,
} from "./link-previews";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const AVIF = new Uint8Array([0, 0, 0, 0x1c, ...new TextEncoder().encode("ftypavif"), 0, 0, 0, 0]);

type Route = (init: RequestInit) => Response | Promise<Response>;

function html(markup: string, headers: Record<string, string> = {}): Response {
  return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

function image(bytes: Uint8Array, type = "image/png", headers: Record<string, string> = {}): Response {
  return new Response(bytes, { headers: { "content-type": type, ...headers } });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function fetcher(routes: Record<string, Route>) {
  return vi.fn(async (input: string, init: RequestInit) => {
    const route = routes[input];
    if (!route) throw new TypeError(`unexpected fetch ${input}`);
    return route(init);
  });
}

async function withPreviews<T>(
  routes: Record<string, Route>,
  run: (input: {
    previews: LinkPreviews;
    fetch: ReturnType<typeof fetcher>;
    bucket: R2Bucket;
    clock: { now: number };
    /** Background work the previews handed to the owning object. */
    tasks: Array<Promise<unknown>>;
    sql: SqlStorage;
  }) => Promise<T>,
  options: { timeoutMs?: number; deadlineMs?: number; bucket?: (bucket: R2Bucket) => R2Bucket } = {},
): Promise<T> {
  return runWithRealKernelSql(async (sql) => {
    const fetch = fetcher(routes);
    const bucket = createInstallationStorage(env.STORAGE, `link-previews-${crypto.randomUUID()}`);
    const clock = { now: 1_000_000 };
    const tasks: Array<Promise<unknown>> = [];
    const previews = new LinkPreviews(sql, options.bucket?.(bucket) ?? bucket, {
      fetch,
      now: () => clock.now,
      timeoutMs: options.timeoutMs,
      deadlineMs: options.deadlineMs,
      keepAlive: (task) => { tasks.push(task); },
    });
    return run({ previews, fetch, bucket, clock, tasks, sql });
  });
}

async function storedImages(bucket: R2Bucket): Promise<number> {
  return (await bucket.list({ prefix: LINK_PREVIEW_IMAGE_PREFIX })).objects.length;
}

async function previewOf(previews: LinkPreviews, url: string) {
  const result = await previews.preview(url);
  if (!result.ok) throw new Error(`expected a preview, got ${result.error}`);
  return result.preview;
}

function category(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LinkPreviewFailure) return error.category;
    throw error;
  }
  return undefined;
}

describe("link preview destination guard", () => {
  it.each([
    "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/", "http://172.16.0.1/",
    "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://0.0.0.0/",
    "http://[::1]/", "http://[fc00::1]/", "http://[fd12::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
    "http://localhost/", "http://LOCALHOST./", "http://app.localhost/", "http://printer.local/",
    "http://metadata.google.internal/", "http://intranet/",
  ])("blocks the private destination %s", (url) => {
    expect(category(() => previewableUrl(url))).toBe("blocked");
  });

  it("blocks credentials and non-default ports", () => {
    expect(category(() => previewableUrl("https://user:pass@example.com/"))).toBe("blocked");
    expect(category(() => previewableUrl("https://user@example.com/"))).toBe("blocked");
    expect(category(() => previewableUrl("https://example.com:8443/"))).toBe("blocked");
    expect(category(() => previewableUrl("http://example.com:443/"))).toBe("blocked");
    expect(previewableUrl("https://example.com:443/a").href).toBe("https://example.com/a");
    expect(previewableUrl("http://example.com:80/a").href).toBe("http://example.com/a");
  });

  it("refuses anything but an absolute http(s) URL and drops the fragment", () => {
    for (const url of ["", "/relative", "ftp://example.com/", "javascript:alert(1)", "data:text/html,hi", `https://example.com/${"a".repeat(2100)}`]) {
      expect(category(() => previewableUrl(url))).toBe("unsupported");
    }
    expect(previewableUrl("https://example.com/page#section").href).toBe("https://example.com/page");
    expect(previewableUrl("https://[2606:4700:4700::1111]/").hostname).toBe("[2606:4700:4700::1111]");
  });

  it("returns a blocked category without fetching", async () => {
    await withPreviews({}, async ({ previews, fetch }) => {
      await expect(previews.preview("http://169.254.169.254/")).resolves.toEqual({ ok: false, error: "blocked" });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("checks every redirect hop and never fetches a private one", async () => {
    await withPreviews({
      "https://example.com/start": () => redirect("http://10.0.0.5/admin"),
    }, async ({ previews, fetch }) => {
      await expect(previews.preview("https://example.com/start")).resolves.toEqual({ ok: false, error: "blocked" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    });
  });

  it("follows at most five redirects, resolving relative locations", async () => {
    const routes: Record<string, Route> = {};
    for (let hop = 0; hop < 6; hop += 1) routes[`https://example.com/${hop}`] = () => redirect(`/${hop + 1}`, 301);
    routes["https://example.com/6"] = () => html("<title>Too far</title>");
    await withPreviews(routes, async ({ previews, fetch }) => {
      await expect(previews.preview("https://example.com/0")).resolves.toEqual({ ok: false, error: "unreachable" });
      expect(fetch).toHaveBeenCalledTimes(6);
    });
    await withPreviews({ ...routes, "https://example.com/0": () => redirect("/2") }, async ({ previews, fetch }) => {
      const preview = await previewOf(previews, "https://example.com/0");
      expect(preview.resolvedUrl).toBe("https://example.com/6");
      expect(preview.title).toBe("Too far");
      expect(fetch).toHaveBeenCalledTimes(6);
    });
  });

  it("identifies itself and asks for HTML", async () => {
    await withPreviews({ "https://example.com/": () => html("<title>Hi</title>") }, async ({ previews, fetch }) => {
      await previews.preview("https://example.com/");
      const headers = new Headers(fetch.mock.calls[0][1].headers);
      expect(headers.get("user-agent")).toContain("GSV-LinkPreview/1.0");
      expect(headers.get("accept")).toContain("text/html");
    });
  });
});

describe("link preview extraction", () => {
  it("reads Open Graph metadata and stores its image", async () => {
    await withPreviews({
      "https://example.com/post": () => html(`<!doctype html><html><head>
        <meta property="og:title" content="A post">
        <meta property="og:description" content="What it says">
        <meta property="og:site_name" content="Example">
        <meta property="og:image" content="/cover.png">
        <meta property="og:image:width" content="1200">
        <meta property="og:image:height" content="630">
        <title>Ignored title</title>
      </head><body></body></html>`),
      "https://example.com/cover.png": () => image(PNG),
    }, async ({ previews, bucket }) => {
      const preview = await previewOf(previews, "https://example.com/post#top");
      expect(preview).toMatchObject({
        url: "https://example.com/post#top",
        resolvedUrl: "https://example.com/post",
        title: "A post",
        description: "What it says",
        siteName: "Example",
        image: { mimeType: "image/png", size: PNG.byteLength, width: 1200, height: 630 },
      });
      const key = preview.image!.key;
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      const stored = await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + key);
      expect(stored?.httpMetadata?.contentType).toBe("image/png");
      expect(stored?.customMetadata).toMatchObject({ purpose: "link-preview", uid: "0", mode: "400" });
      const read = await previews.image(key);
      expect(read.data).toEqual({ ok: true, key, mimeType: "image/png", size: PNG.byteLength });
      expect(await bodyToBytes(read.body!, 1024)).toEqual(PNG);
    });
  });

  it("falls back to Twitter tags, then the title and description", async () => {
    await withPreviews({
      "https://example.com/a": () => html(`<head>
        <meta name="twitter:title" content="Twitter title">
        <meta name="twitter:description" content="Twitter description">
        <meta name="twitter:image" content="https://cdn.example.com/a.jpg">
        <meta name="description" content="Plain description">
        <title>Plain title</title></head>`),
      "https://cdn.example.com/a.jpg": () => image(JPEG, "image/jpeg"),
      "https://example.com/b": () => html(`<head><title>  Plain
        title </title><meta name="description" content="Plain description"></head>`),
    }, async ({ previews }) => {
      expect(await previewOf(previews, "https://example.com/a")).toMatchObject({
        title: "Twitter title",
        description: "Twitter description",
        image: { mimeType: "image/jpeg" },
      });
      const plain = await previewOf(previews, "https://example.com/b");
      expect(plain).toEqual({
        url: "https://example.com/b",
        resolvedUrl: "https://example.com/b",
        title: "Plain title",
        description: "Plain description",
      });
    });
  });

  it("decodes character references, collapses whitespace and caps lengths", async () => {
    const longTitle = "T".repeat(300);
    const longDescription = "D".repeat(800);
    await withPreviews({
      "https://example.com/entities": () => html(`<head>
        <meta property="og:title" content="Fish &amp; Chips &#8212; &#x27;tasty&#39; &ldquo;now&rdquo;&nbsp;&hellip; &bogus; &amp;amp;">
        <meta property="og:description" content="  line one
            line   two  ">
        <title>Caf&eacute; &lt;b&gt;</title></head>`),
      "https://example.com/long": () => html(`<head><title>${longTitle}</title>
        <meta property="og:description" content="${longDescription}"></head>`),
    }, async ({ previews }) => {
      expect(await previewOf(previews, "https://example.com/entities")).toMatchObject({
        title: "Fish & Chips — 'tasty' “now” … &bogus; &amp;",
        description: "line one line two",
      });
      const long = await previewOf(previews, "https://example.com/long");
      expect(Array.from(long.title!)).toHaveLength(200);
      expect(long.title!.endsWith("…")).toBe(true);
      expect(Array.from(long.description!)).toHaveLength(500);
    });
  });

  it("stops reading the page once the head has ended", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const filler = new TextEncoder().encode(`<p>${"x".repeat(16 * 1024)}</p>`);
    const page = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("<html><head><title>Early</title></head><body>"));
          return;
        }
        controller.enqueue(filler);
      },
      cancel,
    }, { highWaterMark: 0 });
    await withPreviews({
      "https://example.com/early": () => new Response(page, { headers: { "content-type": "text/html" } }),
    }, async ({ previews }) => {
      expect(await previewOf(previews, "https://example.com/early")).toMatchObject({ title: "Early" });
      expect(pulls).toBeLessThanOrEqual(3);
      expect(cancel).toHaveBeenCalled();
    });
  });

  it("reads at most the page byte limit", async () => {
    let delivered = 0;
    const chunk = new TextEncoder().encode(`<!-- ${"x".repeat(64 * 1024)} -->`);
    const page = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered > MAX_LINK_PREVIEW_PAGE_BYTES * 2) {
          controller.enqueue(new TextEncoder().encode("<title>Too late</title>"));
          controller.close();
          return;
        }
        delivered += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    await withPreviews({
      "https://example.com/huge": () => new Response(page, { headers: { "content-type": "text/html" } }),
    }, async ({ previews }) => {
      const preview = await previewOf(previews, "https://example.com/huge");
      expect(preview.title).toBeUndefined();
      expect(delivered).toBeLessThanOrEqual(MAX_LINK_PREVIEW_PAGE_BYTES + chunk.byteLength);
    });
  });

  it("returns a bare preview for a non-HTML page and a category for a failed one", async () => {
    await withPreviews({
      "https://example.com/file.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      "https://example.com/missing": () => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }),
      "https://example.com/down": () => { throw new TypeError("network down"); },
    }, async ({ previews }) => {
      expect(await previewOf(previews, "https://example.com/file.pdf")).toEqual({
        url: "https://example.com/file.pdf",
        resolvedUrl: "https://example.com/file.pdf",
      });
      await expect(previews.preview("https://example.com/missing")).resolves.toEqual({ ok: false, error: "unreachable" });
      await expect(previews.preview("https://example.com/down")).resolves.toEqual({ ok: false, error: "unreachable" });
    });
  });

  it("cancels the body of a page it does not read", async () => {
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const unread = (chunk: string, init: ResponseInit): Response => {
      const cancel = vi.fn();
      cancels.push(cancel);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(chunk)); },
        cancel,
      });
      return new Response(stream, init);
    };
    await withPreviews({
      "https://example.com/file.pdf": () => unread("%PDF", { headers: { "content-type": "application/pdf" } }),
      "https://example.com/missing": () => unread("nope", { status: 404, headers: { "content-type": "text/html" } }),
    }, async ({ previews }) => {
      await previews.preview("https://example.com/file.pdf");
      await previews.preview("https://example.com/missing");
      expect(cancels).toHaveLength(2);
      for (const cancel of cancels) expect(cancel).toHaveBeenCalled();
    });
  });

  it("gives the whole preview one deadline across its requests", async () => {
    await withPreviews({
      "https://example.com/slow": () => new Promise<Response>(() => {}),
      "https://example.com/": () => html('<meta property="og:title" content="Shop"><meta property="og:image" content="/shop.png">'),
      "https://example.com/shop.png": () => new Promise<Response>(() => {}),
    }, async ({ previews, fetch }) => {
      // The page itself outlasting the deadline is a failure, even though no single request timed out.
      await expect(previews.preview("https://example.com/slow")).resolves.toEqual({ ok: false, error: "timeout" });
      // The deadline passing during the image leaves the page's preview without one.
      expect(await previewOf(previews, "https://example.com/")).toEqual({
        url: "https://example.com/",
        resolvedUrl: "https://example.com/",
        title: "Shop",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    }, { timeoutMs: 1_000, deadlineMs: 20 });
  });

  it("times out a request that does not answer", async () => {
    await withPreviews({
      "https://example.com/slow": () => new Promise<Response>(() => {}),
      "https://example.com/stalled-body": () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
        headers: { "content-type": "text/html" },
      }),
    }, async ({ previews }) => {
      await expect(previews.preview("https://example.com/slow")).resolves.toEqual({ ok: false, error: "timeout" });
      await expect(previews.preview("https://example.com/stalled-body")).resolves.toEqual({ ok: false, error: "timeout" });
    }, { timeoutMs: 20 });
  });
});

describe("link preview images", () => {
  function pageWithImage(src: string): Route {
    return () => html(`<head><meta property="og:title" content="Page"><meta property="og:image" content="${src}"></head>`);
  }

  it("accepts only supported raster images, typed by their bytes", async () => {
    await withPreviews({
      "https://example.com/svg": pageWithImage("https://example.com/i.svg"),
      "https://example.com/i.svg": () => image(new TextEncoder().encode("<svg/>"), "image/svg+xml"),
      "https://example.com/fake": pageWithImage("https://example.com/fake.png"),
      "https://example.com/fake.png": () => image(new TextEncoder().encode("<html>"), "image/png"),
      "https://example.com/avif": pageWithImage("https://example.com/i.avif"),
      "https://example.com/i.avif": () => image(AVIF, "image/avif"),
      "https://example.com/mislabelled": pageWithImage("https://example.com/m.jpg"),
      "https://example.com/m.jpg": () => image(PNG, "image/jpeg"),
    }, async ({ previews }) => {
      expect((await previewOf(previews, "https://example.com/svg")).image).toBeUndefined();
      expect((await previewOf(previews, "https://example.com/fake")).image).toBeUndefined();
      expect((await previewOf(previews, "https://example.com/avif")).image).toMatchObject({ mimeType: "image/avif" });
      expect((await previewOf(previews, "https://example.com/mislabelled")).image).toMatchObject({ mimeType: "image/png" });
    });
  });

  it("drops an image over the size limit, by length or while streaming", async () => {
    const oversized = new Uint8Array(MAX_LINK_PREVIEW_IMAGE_BYTES + 1);
    oversized.set(PNG);
    await withPreviews({
      "https://example.com/declared": pageWithImage("https://example.com/declared.png"),
      "https://example.com/declared.png": () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
        headers: { "content-type": "image/png", "content-length": String(MAX_LINK_PREVIEW_IMAGE_BYTES + 1) },
      }),
      "https://example.com/streamed": pageWithImage("https://example.com/streamed.png"),
      "https://example.com/streamed.png": () => image(oversized),
    }, async ({ previews, bucket }) => {
      const declared = await previewOf(previews, "https://example.com/declared");
      expect(declared.title).toBe("Page");
      expect(declared.image).toBeUndefined();
      expect((await previewOf(previews, "https://example.com/streamed")).image).toBeUndefined();
      expect(await storedImages(bucket)).toBe(0);
    });
  });

  it("guards the image URL like the page URL", async () => {
    await withPreviews({
      "https://example.com/private": pageWithImage("http://192.168.0.10/cam.jpg"),
      "https://example.com/redirected": pageWithImage("https://example.com/r.png"),
      "https://example.com/r.png": () => redirect("http://localhost/secret.png"),
    }, async ({ previews, fetch }) => {
      expect((await previewOf(previews, "https://example.com/private")).image).toBeUndefined();
      expect((await previewOf(previews, "https://example.com/redirected")).image).toBeUndefined();
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        "https://example.com/private",
        "https://example.com/redirected",
        "https://example.com/r.png",
      ]);
    });
  });

  it("serves only images a cached preview refers to", async () => {
    await withPreviews({}, async ({ previews, bucket }) => {
      await expect(previews.image("../../etc/passwd")).resolves.toEqual({ data: { ok: false, error: "unsupported" } });
      const key = "a".repeat(64);
      await bucket.put(LINK_PREVIEW_IMAGE_PREFIX + key, PNG, { httpMetadata: { contentType: "image/png" } });
      await expect(previews.image(key)).resolves.toEqual({ data: { ok: false, error: "not-found" } });
    });
  });
});

describe("link preview cache", () => {
  it("hands a shared fetch to the owning object so it outlives its callers", async () => {
    await withPreviews({
      "https://example.com/": () => html("<title>Shared</title>"),
    }, async ({ previews, tasks }) => {
      const before = tasks.length;
      await previewOf(previews, "https://example.com/");
      // Pruning and the fetch itself were both registered; the cached answer registers only pruning.
      expect(tasks.length).toBe(before + 2);
      await previewOf(previews, "https://example.com/");
      expect(tasks.length).toBe(before + 3);
    });
  });

  it("answers repeated and concurrent requests from one fetch", async () => {
    await withPreviews({ "https://example.com/": () => html("<title>Once</title>") }, async ({ previews, fetch }) => {
      const [first, second] = await Promise.all([
        previews.preview("https://example.com/"),
        previews.preview("https://example.com/#again"),
      ]);
      expect(first).toMatchObject({ ok: true, preview: { title: "Once" } });
      expect(second).toMatchObject({ ok: true, preview: { title: "Once", url: "https://example.com/#again" } });
      await previews.preview("https://example.com/");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  it("retries a failure after an hour and refreshes a preview after seven days", async () => {
    let failing = true;
    await withPreviews({
      "https://example.com/": () => failing ? new Response("", { status: 503 }) : html("<title>Back</title>"),
    }, async ({ previews, fetch, clock }) => {
      await expect(previews.preview("https://example.com/")).resolves.toEqual({ ok: false, error: "unreachable" });
      failing = false;
      clock.now += LINK_PREVIEW_FAILURE_TTL_MS - 1;
      await expect(previews.preview("https://example.com/")).resolves.toEqual({ ok: false, error: "unreachable" });
      clock.now += 1;
      expect(await previewOf(previews, "https://example.com/")).toMatchObject({ title: "Back" });
      clock.now += LINK_PREVIEW_SUCCESS_TTL_MS - 1;
      await previews.preview("https://example.com/");
      expect(fetch).toHaveBeenCalledTimes(2);
      clock.now += 1;
      await previews.preview("https://example.com/");
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });

  it("retries an advertised image that failed within the hour, not after a week", async () => {
    let imageDown = true;
    await withPreviews({
      "https://example.com/": () => html('<meta property="og:title" content="Shop"><meta property="og:image" content="/shop.png">'),
      "https://example.com/shop.png": () => imageDown ? new Response("", { status: 503 }) : image(PNG),
    }, async ({ previews, fetch, clock }) => {
      expect(await previewOf(previews, "https://example.com/")).toEqual({
        url: "https://example.com/",
        resolvedUrl: "https://example.com/",
        title: "Shop",
      });
      imageDown = false;
      clock.now += LINK_PREVIEW_FAILURE_TTL_MS - 1;
      expect(await previewOf(previews, "https://example.com/")).not.toHaveProperty("image");
      expect(fetch).toHaveBeenCalledTimes(2);
      clock.now += 1;
      expect(await previewOf(previews, "https://example.com/")).toMatchObject({ title: "Shop", image: { mimeType: "image/png" } });
      expect(fetch).toHaveBeenCalledTimes(4);
    });
  });

  it("finishes an image write that outlasts the deadline in the background", async () => {
    let finishPut!: () => void;
    const putting = new Promise<void>((resolve) => { finishPut = resolve; });
    // SAFETY: the wrapper inherits every R2Bucket member from the bucket it is created from and overrides only put.
    const slowPuts = (bucket: R2Bucket): R2Bucket => Object.assign(Object.create(bucket) as R2Bucket, {
      put: async (...args: Parameters<R2Bucket["put"]>) => { await putting; return bucket.put(...args); },
    });
    await withPreviews({
      "https://example.com/": () => html('<meta property="og:title" content="Shop"><meta property="og:image" content="/shop.png">'),
      "https://example.com/shop.png": () => image(PNG),
    }, async ({ previews, bucket, tasks }) => {
      expect(await previewOf(previews, "https://example.com/")).toEqual({
        url: "https://example.com/",
        resolvedUrl: "https://example.com/",
        title: "Shop",
      });
      finishPut();
      await Promise.all(tasks);
      expect(await storedImages(bucket)).toBe(1);
      expect(await previewOf(previews, "https://example.com/")).toMatchObject({ title: "Shop", image: { mimeType: "image/png" } });
    }, { timeoutMs: 1_000, deadlineMs: 20, bucket: slowPuts });
  });

  it("remembers a replaced image it could not delete and removes it on a later pass", async () => {
    let deletesFail = true;
    let cover = "/old.png";
    // SAFETY: the wrapper inherits every R2Bucket member from the bucket it is created from and overrides only delete.
    const flakyDeletes = (bucket: R2Bucket): R2Bucket => Object.assign(Object.create(bucket) as R2Bucket, {
      delete: async (keys: string | string[]) => {
        if (deletesFail) throw new Error("r2 unavailable");
        return bucket.delete(keys);
      },
    });
    await withPreviews({
      "https://example.com/": () => html(`<head><meta property="og:image" content="${cover}"></head>`),
      "https://example.com/old.png": () => image(PNG),
      "https://example.com/new.png": () => image(JPEG, "image/jpeg"),
    }, async ({ previews, bucket, clock, tasks }) => {
      const oldKey = (await previewOf(previews, "https://example.com/")).image!.key;
      clock.now += LINK_PREVIEW_SUCCESS_TTL_MS;
      cover = "/new.png";
      const newKey = (await previewOf(previews, "https://example.com/")).image!.key;
      expect(newKey).not.toBe(oldKey);
      await Promise.all(tasks);
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + oldKey)).not.toBeNull();
      deletesFail = false;
      await previews.pruneExpired();
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + oldKey)).toBeNull();
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + newKey)).not.toBeNull();
      await previews.pruneExpired();
      expect(await storedImages(bucket)).toBe(1);
    }, { bucket: flakyDeletes });
  });

  it("takes a stored image back when its row cannot be written", async () => {
    await withPreviews({
      "https://example.com/": () => html('<head><meta property="og:image" content="/a.png"></head>'),
      "https://example.com/a.png": () => image(PNG),
    }, async ({ previews, bucket, sql }) => {
      const exec = sql.exec.bind(sql);
      let failRowWrite = true;
      vi.spyOn(sql, "exec").mockImplementation((query: string, ...bindings: SqlStorageValue[]) => {
        if (failRowWrite && query.includes("INSERT OR REPLACE INTO link_previews")) {
          failRowWrite = false;
          throw new Error("sqlite busy");
        }
        return exec(query, ...bindings);
      });
      await expect(previews.preview("https://example.com/")).rejects.toThrow("sqlite busy");
      expect(await storedImages(bucket)).toBe(0);
      expect(await previewOf(previews, "https://example.com/")).toMatchObject({ image: { mimeType: "image/png" } });
      expect(await storedImages(bucket)).toBe(1);
    });
  });

  it("keeps the row of an image it could not delete for a later pass", async () => {
    let deletesFail = true;
    // SAFETY: the wrapper inherits every R2Bucket member from the bucket it is created from and overrides only delete.
    const flakyDeletes = (bucket: R2Bucket): R2Bucket => Object.assign(Object.create(bucket) as R2Bucket, {
      delete: async (keys: string | string[]) => {
        if (deletesFail) throw new Error("r2 unavailable");
        return bucket.delete(keys);
      },
    });
    await withPreviews({
      "https://example.com/": () => html('<head><meta property="og:image" content="/a.png"></head>'),
      "https://example.com/a.png": () => image(PNG),
    }, async ({ previews, bucket, clock }) => {
      const key = (await previewOf(previews, "https://example.com/")).image!.key;
      clock.now += LINK_PREVIEW_SUCCESS_TTL_MS;
      await previews.pruneExpired();
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + key)).not.toBeNull();
      await expect(previews.image(key)).resolves.toMatchObject({ data: { ok: true } });
      deletesFail = false;
      await previews.pruneExpired();
      expect(await storedImages(bucket)).toBe(0);
      await expect(previews.image(key)).resolves.toEqual({ data: { ok: false, error: "not-found" } });
    }, { bucket: flakyDeletes });
  });

  it("answers a preview without waiting for expired cleanup", async () => {
    let finishDelete!: () => void;
    const deleting = new Promise<void>((resolve) => { finishDelete = resolve; });
    // SAFETY: the wrapper inherits every R2Bucket member from the bucket it is created from and overrides only delete.
    const slowDeletes = (bucket: R2Bucket): R2Bucket => Object.assign(Object.create(bucket) as R2Bucket, {
      delete: async (keys: string | string[]) => { await deleting; return bucket.delete(keys); },
    });
    await withPreviews({
      "https://example.com/a": () => html('<head><meta property="og:image" content="/a.png"></head>'),
      "https://example.com/a.png": () => image(PNG),
      "https://example.com/b": () => html("<title>B</title>"),
    }, async ({ previews, bucket, clock, tasks }) => {
      const key = (await previewOf(previews, "https://example.com/a")).image!.key;
      clock.now += LINK_PREVIEW_SUCCESS_TTL_MS;
      // b answers while a's expired image is still being deleted; the deletion lives on with the owning object.
      expect(await previewOf(previews, "https://example.com/b")).toMatchObject({ title: "B" });
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + key)).not.toBeNull();
      finishDelete();
      await Promise.all(tasks);
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + key)).toBeNull();
    }, { bucket: slowDeletes });
  });

  it("deletes an expired image no preview refers to and keeps one still in use", async () => {
    let cover = "/old.png";
    await withPreviews({
      "https://example.com/a": () => html(`<head><meta property="og:image" content="${cover}"></head>`),
      "https://example.com/b": () => html(`<head><meta property="og:image" content="/shared.png"></head>`),
      "https://example.com/c": () => html(`<head><meta property="og:image" content="/shared.png"></head>`),
      "https://example.com/old.png": () => image(PNG),
      "https://example.com/new.png": () => image(JPEG, "image/jpeg"),
      "https://example.com/shared.png": () => image(PNG),
    }, async ({ previews, bucket, clock, tasks }) => {
      const oldKey = (await previewOf(previews, "https://example.com/a")).image!.key;
      const sharedKey = (await previewOf(previews, "https://example.com/b")).image!.key;
      clock.now += LINK_PREVIEW_SUCCESS_TTL_MS / 2;
      expect((await previewOf(previews, "https://example.com/c")).image!.key).toBe(sharedKey);
      clock.now += LINK_PREVIEW_SUCCESS_TTL_MS / 2;
      cover = "/new.png";
      const newKey = (await previewOf(previews, "https://example.com/a")).image!.key;
      expect(newKey).not.toBe(oldKey);
      // The replaced image is deleted beside the answer, under the object's lifetime.
      await Promise.all(tasks);
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + oldKey)).toBeNull();
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + newKey)).not.toBeNull();
      // b expired, but c still refers to the same image.
      expect(await bucket.head(LINK_PREVIEW_IMAGE_PREFIX + sharedKey)).not.toBeNull();
      await expect(previews.image(sharedKey)).resolves.toMatchObject({ data: { ok: true } });
      clock.now += LINK_PREVIEW_SUCCESS_TTL_MS;
      await previews.pruneExpired();
      expect(await storedImages(bucket)).toBe(0);
    });
  });
});

describe("link preview handlers", () => {
  function context(previews: LinkPreviews, input: { processId?: string; kind?: "human" | "machine" }): KernelContext {
    const account = { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" };
    // SAFETY: the handlers read only the caller identity and the link preview store.
    return {
      installationId: "inst_test",
      peer: testPeer({ kind: input.kind ?? "human", account, peerId: "client", calls: ["conversation.*"] }),
      processId: input.processId,
      linkPreviews: previews,
    } as KernelContext;
  }

  it("admits only a direct user client", async () => {
    await withPreviews({}, async ({ previews, fetch }) => {
      await expect(handleConversationLinkPreview({ url: "http://localhost/" }, context(previews, {})))
        .resolves.toEqual({ ok: false, error: "blocked" });
      await expect(handleConversationLinkImage({ key: "a".repeat(64) }, context(previews, {})))
        .resolves.toEqual({ data: { ok: false, error: "not-found" } });
      for (const ctx of [context(previews, { processId: "proc:ship" }), context(previews, { kind: "machine" })]) {
        await expect(handleConversationLinkPreview({ url: "https://example.com/" }, ctx))
          .rejects.toThrow("Conversation operations require a direct user client");
        await expect(handleConversationLinkImage({ key: "a".repeat(64) }, ctx))
          .rejects.toThrow("Conversation operations require a direct user client");
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
