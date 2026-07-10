import type { Env } from "./types";

const EMBED_MODEL = "@cf/baai/bge-m3";

export async function embed(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run(EMBED_MODEL, { text: [text] });
  const vector = (result as { data: number[][] }).data[0];
  if (!vector) {
    throw new Error("Embedding model returned no vector");
  }
  return vector;
}
