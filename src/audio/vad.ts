import { MicVAD, utils } from "@ricky0123/vad-web";

// Self-hosting the ONNX runtime WASM (13-27MB per variant) would bloat this
// mobile-first app badly, so we pin the CDN build the library itself ships
// with default asset resolution against — versions match installed deps.
const VAD_ASSET_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/";
const ORT_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

export interface VadHandle {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
}

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (wavBlob: Blob) => void;
  /** Diagnostic: fires per audio frame (~30/sec) so callers can confirm
   * mic audio is actually reaching the VAD model, not just that init succeeded. */
  onFrameProcessed?: (isSpeechProb: number) => void;
}

// Throws if mic permission is denied or the VAD assets fail to load —
// callers should wrap in try/catch.
export async function createVad(callbacks: VadCallbacks): Promise<VadHandle> {
  const vad = await MicVAD.new({
    baseAssetPath: VAD_ASSET_BASE,
    onnxWASMBasePath: ORT_WASM_BASE,
    // The threaded onnxruntime-web WASM build needs SharedArrayBuffer, which
    // requires COOP/COEP cross-origin-isolation headers we don't set (and
    // adding them risks breaking other cross-origin fetches). Force
    // single-threaded WASM so this works on a plain origin, incl. iOS Safari.
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
    },
    onSpeechStart: () => callbacks.onSpeechStart(),
    onSpeechEnd: (audio) => {
      const wavBuffer = utils.encodeWAV(audio, undefined, 16000, 1, 16);
      callbacks.onSpeechEnd(new Blob([wavBuffer], { type: "audio/wav" }));
    },
    onFrameProcessed: (probabilities) => {
      callbacks.onFrameProcessed?.(probabilities.isSpeech);
    },
  });

  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy(),
  };
}
