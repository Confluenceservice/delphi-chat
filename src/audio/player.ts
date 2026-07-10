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
