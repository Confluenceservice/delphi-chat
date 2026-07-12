import { apiFetch } from "./http";

export async function getPersona(): Promise<string> {
  const response = await apiFetch("/api/persona");
  if (!response.ok) throw new Error(`Failed to load persona (${response.status})`);
  const data = await response.json();
  return data.persona ?? "";
}

export async function savePersona(persona: string): Promise<void> {
  const response = await apiFetch("/api/persona", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  if (!response.ok) throw new Error(`Failed to save persona (${response.status})`);
}
