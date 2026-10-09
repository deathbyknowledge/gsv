export const VOICE_WAVEFORM_COLUMNS = 80;

/** Observe the recorder's stream without connecting it to the speakers or owning its tracks. */
export function observeVoiceWaveform(stream: MediaStream, draw: (levels: Float32Array) => void, failed: () => void): () => void {
  const context = new AudioContext();
  let source: MediaStreamAudioSourceNode | null = null;
  let frame = 0, previous = 0, peak = 0, closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(frame);
    source?.disconnect();
    void context.close().catch((error) => console.error("Could not close voice visualization", error));
  };
  try {
    source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levels = new Float32Array(VOICE_WAVEFORM_COLUMNS);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sample = (now: number) => {
      analyser.getFloatTimeDomainData(samples);
      let power = 0;
      for (const value of samples) power += value * value;
      peak = Math.max(peak, Math.sqrt(power / samples.length));
      if (now - previous >= (motion.matches ? 250 : 60)) {
        levels.copyWithin(0, 1);
        levels[levels.length - 1] = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(peak, 0.001)) + 60) / 60));
        draw(levels);
        previous = now;
        peak = 0;
      }
      frame = requestAnimationFrame(sample);
    };
    void context.resume().then(() => {
      if (!closed) frame = requestAnimationFrame(sample);
    }).catch((error) => {
      if (closed) return;
      console.error("Voice visualization unavailable", error);
      dispose();
      failed();
    });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
