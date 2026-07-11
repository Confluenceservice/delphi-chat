import { MicVAD, utils } from "@ricky0123/vad-web";

// Self-hosting the ONNX runtime WASM (13-27MB per variant) would bloat this
// mobile-first app badly, so we pin the CDN build the library itself ships
// with default asset resolution against — versions match installed deps.
const VAD_ASSET_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/";
const ORT_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

// vad-web frames are always 16 kHz mono (the Silero model requires it).
const SAMPLE_RATE = 16000;

// Endpointer tuning — all ours. vad-web is used purely as a per-frame audio +
// speech-probability source; we do the start/silence detection ourselves
// because vad-web's built-in redemption endpointer never fires onSpeechEnd on
// noisy mobile mics (brief probability spikes keep resetting its counter).
const START_THRESHOLD = 0.6; // probability required to begin a turn
const VOICE_PRESENT_THRESHOLD = 0.5; // probability that keeps a turn alive
const SILENCE_MS = 900; // trailing silence after which a turn ends
const MIN_SPEECH_MS = 300; // shorter segments are treated as noise (misfire)
const PRE_PAD_FRAMES = 10; // frames of audio kept before speech start

export interface VadHandle {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
}

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (wavBlob: Blob) => void;
  /** A detected segment was shorter than MIN_SPEECH_MS and was discarded. */
  onMisfire?: () => void;
  /** Something threw while finalizing a segment (e.g. WAV encoding). */
  onError?: (message: string) => void;
  /** Diagnostic: fires per audio frame (~30/sec) with the speech probability
   * and, while in a turn, how long since voice was last heard (ms). */
  onFrameProcessed?: (isSpeechProb: number, silenceMs: number) => void;
}

function concatFrames(frames: Float32Array[], totalSamples: number): Float32Array {
  const out = new Float32Array(totalSamples);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

// Throws if mic permission is denied or the VAD assets fail to load —
// callers should wrap in try/catch.
export async function createVad(callbacks: VadCallbacks): Promise<VadHandle> {
  let inTurn = false;
  let lastVoiceTs = 0;
  let segment: Float32Array[] = [];
  const pad: Float32Array[] = [];
  const now = () => performance.now();

  const vad = await MicVAD.new({
    baseAssetPath: VAD_ASSET_BASE,
    onnxWASMBasePath: ORT_WASM_BASE,
    // Force single-threaded WASM: the default threaded build needs
    // SharedArrayBuffer (COOP/COEP headers we don't set), incl. on iOS Safari.
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
    },
    // We do our own endpointing, so keep vad-web's own segment events inert.
    onSpeechStart: () => {},
    onSpeechEnd: () => {},
    onVADMisfire: () => {},
    onFrameProcessed: (probabilities, frame) => {
      const prob = probabilities.isSpeech;
      callbacks.onFrameProcessed?.(prob, inTurn ? now() - lastVoiceTs : 0);

      // Always keep a short rolling pre-speech pad so we don't clip word onsets.
      pad.push(frame);
      if (pad.length > PRE_PAD_FRAMES) pad.shift();

      if (!inTurn) {
        if (prob >= START_THRESHOLD) {
          inTurn = true;
          lastVoiceTs = now();
          segment = [...pad];
          callbacks.onSpeechStart();
        }
        return;
      }

      segment.push(frame);
      if (prob >= VOICE_PRESENT_THRESHOLD) lastVoiceTs = now();

      if (now() - lastVoiceTs > SILENCE_MS) {
        inTurn = false;
        const frames = segment;
        segment = [];
        try {
          const totalSamples = frames.reduce((n, f) => n + f.length, 0);
          const durationMs = (totalSamples / SAMPLE_RATE) * 1000;
          if (durationMs >= MIN_SPEECH_MS) {
            const audio = concatFrames(frames, totalSamples);
            const wavBuffer = utils.encodeWAV(audio, undefined, SAMPLE_RATE, 1, 16);
            callbacks.onSpeechEnd(new Blob([wavBuffer], { type: "audio/wav" }));
          } else {
            callbacks.onMisfire?.();
          }
        } catch (err) {
          callbacks.onError?.(err instanceof Error ? err.message : String(err));
        }
      }
    },
  });

  return {
    start: async () => {
      inTurn = false;
      segment = [];
      await vad.start();
    },
    pause: async () => {
      inTurn = false;
      segment = [];
      await vad.pause();
    },
    destroy: () => vad.destroy(),
  };
}
