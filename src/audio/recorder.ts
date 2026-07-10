export interface Recording {
  blob: Blob;
  mimeType: string;
}

// iOS Safari has no webm support and only emits audio/mp4 (AAC); other
// browsers prefer webm/opus. Try the efficient option first, fall through.
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(candidate)) {
      return candidate;
    }
  }
  return "";
}

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];

export async function startRecording(): Promise<void> {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();
}

export function stopRecording(): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const active = recorder;
    const activeStream = stream;
    if (!active) {
      reject(new Error("Not recording"));
      return;
    }
    active.onstop = () => {
      const mimeType = active.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type: mimeType });
      activeStream?.getTracks().forEach((t) => t.stop());
      chunks = [];
      resolve({ blob, mimeType });
    };
    active.stop();
    recorder = null;
    stream = null;
  });
}

export function cancelRecording(): void {
  recorder?.stop();
  stream?.getTracks().forEach((t) => t.stop());
  recorder = null;
  stream = null;
  chunks = [];
}
