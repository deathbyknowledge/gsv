import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(value, fallback, variable) {
  if (!value) {
    return fallback;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${variable} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${variable} must be a JSON array of strings`);
  }
  return parsed;
}

function mimeTypeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".ogg" || extension === ".opus") return "audio/ogg";
  if (extension === ".webm") return "audio/webm";
  return "application/octet-stream";
}

function waitForExit(child, signal, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Audio process did not stop"));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGTERM");
      finish(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
    };
    child.once("error", (error) => finish(error));
    child.once("exit", (code, exitSignal) => {
      if (code === 0 || exitSignal === "SIGINT" || exitSignal === "SIGTERM") {
        finish();
      } else {
        finish(new Error(`Audio process exited with code ${code ?? "unknown"}`));
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class AudioCapture {
  constructor(config) {
    this.sampleFile = config.sampleFile?.trim() || "";
    this.bin = config.captureBin?.trim() || "arecord";
    this.args = parseArgs(
      config.captureArgs,
      ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "{output}"],
      "GSV_HDZERO_CAPTURE_ARGS",
    );
    this.child = null;
    this.waiting = null;
    this.directory = null;
    this.output = null;
  }

  async start(signal) {
    if (this.child || this.output) {
      throw new Error("Microphone capture is already active");
    }
    if (this.sampleFile) {
      this.output = this.sampleFile;
      return;
    }
    this.directory = await mkdtemp(path.join(tmpdir(), "gsv-hdzero-capture-"));
    this.output = path.join(this.directory, "capture.wav");
    const args = this.args.map((arg) => arg.replaceAll("{output}", this.output));
    this.child = spawn(this.bin, args, { stdio: "ignore" });
    this.waiting = waitForExit(this.child, signal);
    void this.waiting.catch(() => {});
    try {
      await new Promise((resolve, reject) => {
        const started = setTimeout(resolve, 40);
        this.child.once("error", (error) => {
          clearTimeout(started);
          reject(error);
        });
      });
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }

  async stop() {
    const output = this.output;
    if (!output) {
      throw new Error("Microphone capture is not active");
    }
    if (this.child) {
      this.child.kill("SIGINT");
      await this.waiting.catch(() => {});
    }
    try {
      const bytes = new Uint8Array(await readFile(output));
      if (bytes.byteLength === 0) {
        throw new Error("Microphone capture was empty");
      }
      return { bytes, mimeType: mimeTypeFor(output), filename: path.basename(output) };
    } finally {
      await this.cleanup();
    }
  }

  async cancel() {
    if (this.child) {
      this.child.kill("SIGTERM");
      await this.waiting?.catch(() => {});
    }
    await this.cleanup();
  }

  async cleanup() {
    const directory = this.directory;
    this.child = null;
    this.waiting = null;
    this.directory = null;
    this.output = null;
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class AudioPlayback {
  constructor(config) {
    this.bin = config.playbackBin?.trim() || "ffplay";
    this.args = parseArgs(
      config.playbackArgs,
      ["-nodisp", "-autoexit", "-loglevel", "quiet", "{input}"],
      "GSV_HDZERO_PLAYBACK_ARGS",
    );
    this.child = null;
  }

  async play(audio, signal) {
    const directory = await mkdtemp(path.join(tmpdir(), "gsv-hdzero-speech-"));
    const extension = audio.mimeType === "audio/mpeg" ? ".mp3"
      : audio.mimeType === "audio/ogg" ? ".ogg"
        : audio.mimeType === "audio/wav" ? ".wav" : ".bin";
    const input = path.join(directory, `speech${extension}`);
    try {
      await writeFile(input, audio.bytes);
      const args = this.args.map((arg) => arg.replaceAll("{input}", input));
      this.child = spawn(this.bin, args, { stdio: "ignore" });
      await waitForExit(this.child, signal, 120_000);
    } finally {
      this.child = null;
      await rm(directory, { recursive: true, force: true });
    }
  }

  async cancel() {
    this.child?.kill("SIGTERM");
  }
}

export class MockCapture {
  async start(signal) {
    signal?.throwIfAborted();
  }

  async stop() {
    return {
      bytes: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      filename: "mock.wav",
    };
  }

  async cancel() {}
}

export class MockPlayback {
  async play() {}
  async cancel() {}
}
