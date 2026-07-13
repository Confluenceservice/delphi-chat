export type Role = "user" | "assistant" | "system";

export interface Source {
  title: string;
  url: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  images?: string[]; // data URLs, attached by the user
  sources?: Source[]; // web_search results, attached to assistant replies
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
