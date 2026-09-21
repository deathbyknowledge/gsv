import type { NativeEvent, NativeVoice } from "./PlatformProvider";

type DraftSelection = { value: string; start: number; end: number };
const unspaced = /[\u0e00-\u0e7f\u1100-\u11ff\u2e80-\u2fff\u3040-\u30ff\u3130-\u318f\u31a0-\u31bf\u31f0-\u31ff\u3400-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
function boundary(left: string, right: string): string {
  const a = Array.from(left).at(-1), b = Array.from(right)[0];
  if (!a || !b || /\s/u.test(a + b) || unspaced.test(a + b)
    || /[.,!?;:%)\]}>’”]/u.test(b) || /[(\[{<‘“/\\\-–—_]/u.test(a)) return "";
  return /[\p{L}\p{N}.,!?;:%)\]}>’”]/u.test(a) && /[\p{L}\p{N}(\[{<‘“]/u.test(b) ? " " : "";
}
export function composeVoice(before: string, text: string, after: string): { value: string; caret: number } {
  const voice = text.trim();
  const prefix = before + boundary(before, voice) + voice;
  return { value: prefix + boundary(voice, after) + after, caret: prefix.length };
}
function joinVoice(a: string, b: string): string { return composeVoice(a, b, "").value; }

/** A correlated voice-owned range; manual edits outside it remain typed anchors. */
export class VoiceDraft {
  readonly requestId: number;
  segment = 0;
  revision = -1;
  private before: string;
  private after: string;
  private settled = "";
  rendered: string;

  constructor(requestId: number, selection: DraftSelection) {
    this.requestId = requestId;
    this.before = selection.value.slice(0, selection.start);
    this.after = selection.value.slice(selection.start);
    this.rendered = selection.value;
  }

  private render(text: string) {
    const result = composeVoice(this.before, text, this.after);
    this.rendered = result.value;
    return result;
  }

  partial(voice: NativeVoice) {
    if (voice.request_id !== this.requestId || voice.segment_id !== this.segment || voice.revision <= this.revision) return null;
    this.revision = voice.revision;
    return this.render(joinVoice(this.settled, voice.text));
  }

  /** Editing inside dictated text ends its ownership; late partials must not undo the edit. */
  edit(value: string): boolean {
    if (value === this.rendered) return true;
    const previous = this.rendered;
    let start = 0;
    while (start < value.length && start < previous.length && value[start] === previous[start]) start++;
    let oldEnd = previous.length, newEnd = value.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
    const voiceEnd = previous.length - this.after.length;
    if (oldEnd <= this.before.length) this.before = value.slice(0, this.before.length + value.length - previous.length);
    else if (start >= voiceEnd) this.after = value.slice(voiceEnd);
    else return false;
    this.rendered = value;
    return true;
  }

  finish(event: NativeEvent) {
    if (event.request_id !== this.requestId || event.segment_id !== this.segment) return null;
    let text = joinVoice(this.settled, event.text);
    if (event.action === "clear") text = "";
    if (event.action === "delete") {
      // Segmenter deletes a complete user-perceived character, including emoji joins.
      const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.trimEnd()));
      text = segments.slice(0, -1).map((part) => part.segment).join("");
    }
    this.segment++;
    this.revision = -1;
    this.settled = text;
    return this.render(text);
  }

  sent(selection: DraftSelection): void {
    this.before = selection.value.slice(0, selection.start);
    this.after = selection.value.slice(selection.start);
    this.settled = "";
    this.rendered = selection.value;
  }
}
