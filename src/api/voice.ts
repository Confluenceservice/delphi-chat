export async function getVoice(): Promise<string | null> {
  const response = await fetch("/api/voice");
  if (!response.ok) throw new Error(`Failed to load voice (${response.status})`);
  const data = await response.json();
  return data.voiceId ?? null;
}

export async function saveVoice(voiceId: string): Promise<void> {
  const response = await fetch("/api/voice", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceId }),
  });
  if (!response.ok) throw new Error(`Failed to save voice (${response.status})`);
}
