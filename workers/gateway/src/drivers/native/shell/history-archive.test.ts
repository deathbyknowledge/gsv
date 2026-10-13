import { describe, expect, it } from "vitest";
import { readArchiveHistory } from "./history-archive";

function archive(rows: Iterable<string>): ReadableStream<Uint8Array> {
  const iterator = rows[Symbol.iterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const item = iterator.next();
      if (item.done) controller.close();
      else controller.enqueue(encoder.encode(`${item.value}\n`));
    },
    cancel() { iterator.return?.(); },
  }).pipeThrough(new CompressionStream("gzip"));
}

function message(id: number, generation = 1, content = `Message ${id}`): string {
  return JSON.stringify({ id, generation, role: "user", content });
}

describe("archive history pages", () => {
  it("filters original IDs before paging and preserves Unicode", async () => {
    const rows = [message(1), message(2), message(3, 2), message(3, 1, "Groen 🌱"), message(4), message(5)];
    const first = await readArchiveHistory(archive(rows), { generation: 1, afterMessageId: 1, throughMessageId: 4, limit: 2 });
    expect(first.messages.map(({ id, content }) => [id, content])).toEqual([[2, "Message 2"], [3, "Groen 🌱"]]);
    expect(first).toMatchObject({ offset: 0, nextOffset: 2, hasMore: true });
    const last = await readArchiveHistory(archive(rows), { generation: 1, afterMessageId: 1, throughMessageId: 4, offset: first.nextOffset, limit: 2 });
    expect(last.messages.map(({ id }) => id)).toEqual([4]);
    expect(last).toMatchObject({ nextOffset: 3, hasMore: false });
  });

  it("reaches records beyond 128 MiB of expanded history without buffering the archive", async () => {
    function* rows() {
      const padding = "x".repeat(128 * 1024);
      for (let id = 1; id <= 1_030; id += 1) yield message(id, 1, padding);
    }
    const page = await readArchiveHistory(archive(rows()), { offset: 1_025, limit: 1 });
    expect(page.messages.map(({ id }) => id)).toEqual([1_026]);
    expect(page).toMatchObject({ nextOffset: 1_026, hasMore: true });
  }, 60_000);

  it("propagates corrupt records and cancellation rather than returning a complete page", async () => {
    await expect(readArchiveHistory(archive([message(1), "invalid json"]), {})).rejects.toThrow();
    await expect(readArchiveHistory(archive([message(1)]), {}, AbortSignal.abort(new Error("Cancelled archive read"))))
      .rejects.toThrow("Cancelled archive read");
  });
});
