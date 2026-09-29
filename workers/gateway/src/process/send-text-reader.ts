/**
 * Reads the `text` argument of a Send call out of its argument JSON while the
 * model is still writing it, so the person sees the reply grow as it is typed.
 *
 * The reader is a small state machine over the top-level object: it skips the
 * members before `text`, whatever their shape, decodes the `text` string and
 * stops at its closing quote. It only ever yields complete, unescaped
 * characters: an escape sequence, a `\uXXXX` code and a surrogate pair each
 * wait until their last unit has arrived, however the chunks are cut. Anything
 * it does not understand ends the read; the committed message still reconciles
 * against what was streamed, so a stalled reader only costs the live preview.
 */

type ObjectState =
  | "object"
  | "member"
  | "key"
  | "colon"
  | "value"
  | "text"
  | "skip-string"
  | "skip-nested"
  | "skip-scalar"
  | "separator"
  | "done";

const TEXT_KEY = "text";

function isWhitespace(unit: string): boolean {
  return unit === " " || unit === "\n" || unit === "\r" || unit === "\t";
}

function isHexDigit(unit: string): boolean {
  return /^[0-9a-fA-F]$/.test(unit);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Decodes one JSON string literal a unit at a time, releasing only whole characters. */
class JsonStringDecoder {
  private escape = false;
  private unicode: string | null = null;
  private high: string | null = null;
  private out = "";

  /** Returns `closed` at the unescaped closing quote, `invalid` on a malformed escape, `open` otherwise. */
  feed(unit: string): "open" | "closed" | "invalid" {
    if (this.unicode !== null) {
      if (!isHexDigit(unit)) return "invalid";
      this.unicode += unit;
      if (this.unicode.length === 4) {
        const code = Number.parseInt(this.unicode, 16);
        this.unicode = null;
        this.deliver(String.fromCharCode(code));
      }
      return "open";
    }
    if (this.escape) {
      this.escape = false;
      switch (unit) {
        case '"': this.deliver('"'); return "open";
        case "\\": this.deliver("\\"); return "open";
        case "/": this.deliver("/"); return "open";
        case "b": this.deliver("\b"); return "open";
        case "f": this.deliver("\f"); return "open";
        case "n": this.deliver("\n"); return "open";
        case "r": this.deliver("\r"); return "open";
        case "t": this.deliver("\t"); return "open";
        case "u": this.unicode = ""; return "open";
        default: return "invalid";
      }
    }
    if (unit === "\\") {
      this.escape = true;
      return "open";
    }
    if (unit === '"') {
      if (this.high !== null) {
        this.out += this.high;
        this.high = null;
      }
      return "closed";
    }
    this.deliver(unit);
    return "open";
  }

  /** The characters decoded since the last take. */
  take(): string {
    const text = this.out;
    this.out = "";
    return text;
  }

  private deliver(unit: string): void {
    const code = unit.charCodeAt(0);
    if (this.high !== null) {
      const high = this.high;
      this.high = null;
      if (isLowSurrogate(code)) {
        this.out += high + unit;
        return;
      }
      this.out += high;
    }
    if (isHighSurrogate(code)) {
      this.high = unit;
      return;
    }
    this.out += unit;
  }
}

export class SendTextReader {
  private state: ObjectState = "object";
  private decoder = new JsonStringDecoder();
  private key = "";
  private depth = 0;
  private inNestedString = false;
  private nestedEscape = false;
  private skipEscape = false;
  private decoded = "";

  /** The `text` decoded so far. */
  get text(): string {
    return this.decoded;
  }

  /** True once `text` has closed, the object ended without it, or the JSON stopped making sense. */
  get done(): boolean {
    return this.state === "done";
  }

  /** Feeds the next chunk of argument JSON and returns the `text` characters it completed. */
  push(chunk: string): string {
    let emitted = "";
    for (let index = 0; index < chunk.length && this.state !== "done"; index += 1) {
      emitted += this.feed(chunk[index]);
    }
    return emitted;
  }

  private feed(unit: string): string {
    switch (this.state) {
      case "object":
        if (isWhitespace(unit)) return "";
        this.state = unit === "{" ? "member" : "done";
        return "";
      case "member":
        if (isWhitespace(unit)) return "";
        if (unit === '"') {
          this.decoder = new JsonStringDecoder();
          this.key = "";
          this.state = "key";
          return "";
        }
        this.state = "done";
        return "";
      case "key": {
        const outcome = this.decoder.feed(unit);
        this.key += this.decoder.take();
        if (outcome === "invalid") this.state = "done";
        else if (outcome === "closed") this.state = "colon";
        return "";
      }
      case "colon":
        if (isWhitespace(unit)) return "";
        this.state = unit === ":" ? "value" : "done";
        return "";
      case "value":
        if (isWhitespace(unit)) return "";
        if (unit === '"') {
          if (this.key === TEXT_KEY) {
            this.decoder = new JsonStringDecoder();
            this.state = "text";
          } else {
            this.skipEscape = false;
            this.state = "skip-string";
          }
          return "";
        }
        if (unit === "{" || unit === "[") {
          this.depth = 1;
          this.inNestedString = false;
          this.nestedEscape = false;
          this.state = "skip-nested";
          return "";
        }
        if (unit === "," || unit === "}") {
          this.state = "done";
          return "";
        }
        this.state = "skip-scalar";
        return "";
      case "text": {
        const outcome = this.decoder.feed(unit);
        const emitted = this.decoder.take();
        this.decoded += emitted;
        if (outcome !== "open") this.state = "done";
        return emitted;
      }
      case "skip-string":
        if (this.skipEscape) this.skipEscape = false;
        else if (unit === "\\") this.skipEscape = true;
        else if (unit === '"') this.state = "separator";
        return "";
      case "skip-nested":
        if (this.inNestedString) {
          if (this.nestedEscape) this.nestedEscape = false;
          else if (unit === "\\") this.nestedEscape = true;
          else if (unit === '"') this.inNestedString = false;
          return "";
        }
        if (unit === '"') this.inNestedString = true;
        else if (unit === "{" || unit === "[") this.depth += 1;
        else if (unit === "}" || unit === "]") {
          this.depth -= 1;
          if (this.depth === 0) this.state = "separator";
        }
        return "";
      case "skip-scalar":
        if (unit === ",") this.state = "member";
        else if (unit === "}") this.state = "done";
        else if (isWhitespace(unit)) this.state = "separator";
        return "";
      case "separator":
        if (isWhitespace(unit)) return "";
        this.state = unit === "," ? "member" : "done";
        return "";
      case "done":
        return "";
    }
  }
}
