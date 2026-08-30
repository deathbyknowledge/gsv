/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- The checked-in corpus is the typed fixture under test. */
import { describe, expect, it } from "vitest";
import type { SyscallName, WireResponseEnvelope } from "@humansandmachines/gsv/protocol";
import {
  decodeWireFrameJson,
  decodeWireResponse,
} from "../../../../gateway/src/protocol/decode-wire-frame";
import corpus from "../corpus/v3-frames.json";
import type { ControlFrame } from "../src/types";

const frames = corpus.map((entry) => entry.frame as ControlFrame);

describe("protocol-v3 source corpus", () => {
  it("is accepted by the current envelope and call-specific request validators", () => {
    for (const frame of frames) {
      expect(decodeWireFrameJson(JSON.stringify(frame))).toEqual(frame);
    }
  });

  it("accepts successful and failed responses under their routed syscall contracts", () => {
    for (const entry of corpus) {
      if (!("routedCall" in entry)) continue;
      expect(decodeWireResponse(
        entry.routedCall as SyscallName,
        entry.frame as WireResponseEnvelope,
      )).toEqual(entry.frame);
    }
  });
});
