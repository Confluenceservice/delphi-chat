function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

export async function transcribeAudio(blob: Blob, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("file", blob, `audio.${extensionFor(mimeType)}`);

  const response = await fetch("/api/stt", { method: "POST", body: form });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? `Transcription failed (${response.status})`);
  }
  const data = await response.json();
  return data.text ?? "";
}
