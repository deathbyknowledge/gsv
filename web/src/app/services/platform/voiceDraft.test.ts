import { describe, expect, it } from "vitest";
import { VoiceDraft, composeVoice } from "./voiceDraft";
import type { NativeEvent, NativeVoice } from "./PlatformProvider";

const partial = (text: string, segment = 0, revision = 1): NativeVoice => ({
  request_id: 7, segment_id: segment, revision, text, phase: "listening", progress: null,
  muted: false, mute_pending: false, pending: null,
});
const completion = (action: NativeEvent["action"], text: string, segment = 0): NativeEvent => ({
  id: 1, request_id: 7, segment_id: segment, kind: "segment", action, text,
});

describe("native dictation ownership", () => {
  it("preserves typed anchors and cannot resurrect a cleared segment", () => {
    const draft = new VoiceDraft(7, { value: "Ask tomorrow.", start: 4, end: 4 });
    expect(draft.partial(partial("Ship"))?.value).toBe("Ask Ship tomorrow.");
    expect(draft.finish(completion("clear", "Ship"))?.value).toBe("Ask tomorrow.");
    expect(draft.partial(partial("old delayed text", 0, 99))).toBeNull();
    expect(draft.partial(partial("again", 1))?.value).toBe("Ask again tomorrow.");
  });

  it("deletes a whole joined emoji without deleting typed text", () => {
    const draft = new VoiceDraft(7, { value: "typed: ", start: 7, end: 7 });
    expect(draft.finish(completion("delete", "hi 👨‍👩‍👧‍👦"))?.value).toBe("typed: hi");
    expect(draft.partial(partial("there", 1))?.value).toBe("typed: hi there");
  });

  it("fences duplicate finals after sending and rebases onto a newer draft", () => {
    const draft = new VoiceDraft(7, { value: "", start: 0, end: 0 });
    expect(draft.finish(completion("send", "first"))?.value).toBe("first");
    draft.sent({ value: "next: ", start: 6, end: 6 });
    expect(draft.finish(completion("send", "first"))).toBeNull();
    expect(draft.partial(partial("second", 1))?.value).toBe("next: second");
    expect(draft.partial({ ...partial("wrong request", 1, 99), request_id: 9 })).toBeNull();
  });

  it("retains typing beside dictation and relinquishes ownership for edits inside it", () => {
    const draft = new VoiceDraft(7, { value: "Ask ", start: 4, end: 4 });
    draft.partial(partial("Ship"));
    expect(draft.edit("Please ask Ship")).toBe(true);
    expect(draft.partial(partial("Ship tomorrow", 0, 2))?.value).toBe("Please ask Ship tomorrow");
    expect(draft.edit("Please ask corrected tomorrow")).toBe(false);
  });

  it("keeps punctuation and unspaced scripts intact", () => {
    expect(composeVoice("(", "hello", ")").value).toBe("(hello)");
    expect(composeVoice("你好", "世界", "！").value).toBe("你好世界！");
  });
});
