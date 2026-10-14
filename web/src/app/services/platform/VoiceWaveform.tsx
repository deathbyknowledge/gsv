import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { observeVoiceWaveform, VOICE_WAVEFORM_COLUMNS } from "./observeVoiceWaveform";

const WIDTH = VOICE_WAVEFORM_COLUMNS * 8;
const HEIGHT = 56;
const baseline = Array.from({ length: VOICE_WAVEFORM_COLUMNS }, (_, index) => `M${index * 8 + 2},27v2`).join("");

export function VoiceWaveform({ stream }: { stream: MediaStream | null }) {
  const trace = useRef<SVGPathElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useLayoutEffect(() => {
    if (!stream) return;
    setUnavailable(false);
    try {
      return observeVoiceWaveform(stream, (levels) => {
        let path = "";
        for (const [index, level] of levels.entries()) {
          if (level <= 0) continue;
          const height = Math.max(2, Math.round(level * 13) * 4);
          path += `M${index * 8 + 2},${(HEIGHT - height) / 2}v${height}`;
        }
        trace.current?.setAttribute("d", path);
      }, () => setUnavailable(true));
    } catch (error) {
      console.error("Voice visualization unavailable", error);
      setUnavailable(true);
    }
  }, [stream]);
  return <>
    <svg class="browser-voice-waveform" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      <path class="browser-voice-baseline" d={baseline} />
      <path ref={trace} class="browser-voice-trace" />
    </svg>
    {unavailable && <span class="browser-voice-notice" role="status">Recording continues; waveform unavailable.</span>}
  </>;
}
