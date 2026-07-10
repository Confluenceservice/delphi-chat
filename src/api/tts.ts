export async function synthesizeSpeech(text: string): Promise<Blob> {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? `TTS request failed (${response.status})`);
  }

  return response.blob();
}
