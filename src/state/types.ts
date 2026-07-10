export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  content: string;
}

export interface Thread {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  messages: Message[];
}

export const MODELS = ["MiniMax-M3", "MiniMax-M2.7"] as const;
export type Model = (typeof MODELS)[number];
export const DEFAULT_MODEL: Model = "MiniMax-M3";
