// Single shared <audio> element so playback can be triggered from a user
// gesture (tap-to-play) and reused across messages/conversation mode without
// re-triggering mobile autoplay restrictions each time.
let audioEl: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

function getAudioEl(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "auto";
  }
  return audioEl;
}

// A tiny silent WAV, used to "unlock" the shared audio element inside a
// user-gesture handler so later async playback (after fetch/TTS latency)
// is allowed by mobile autoplay restrictions.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export async function unlockAudio(): Promise<void> {
  const el = getAudioEl();
  el.src = SILENT_WAV;
  try {
    await el.play();
    el.pause();
    el.currentTime = 0;
  } catch {
    // best effort — some browsers still allow playback later in this gesture chain
  }
}

export async function playBlob(blob: Blob): Promise<void> {
  const el = getAudioEl();
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
  }
  currentUrl = URL.createObjectURL(blob);
  el.src = currentUrl;
  await el.play();
}

export function stopPlayback(): void {
  if (!audioEl) return;
  audioEl.pause();
  audioEl.currentTime = 0;
}

export function onPlaybackEnded(handler: () => void): () => void {
  const el = getAudioEl();
  el.addEventListener("ended", handler);
  return () => el.removeEventListener("ended", handler);
}
