export type Role = "user" | "assistant" | "system";

export type ChatMode = "answer" | "tutor";

export interface Source {
  title: string;
  url: string;
}

export interface CorpusSource {
  docId: string;
  title: string;
  origin: "seed" | "community";
  chunk: string;
  index: number;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  images?: string[]; // data URLs, attached by the user
  sources?: Source[]; // web_search results, attached to assistant replies
  mode?: ChatMode; // mode the assistant reply was generated in
  grounded?: boolean; // true if corpusSources has any hits
  corpusSources?: CorpusSource[]; // approved knowledge-base excerpts used
  kbSuggested?: boolean; // "suggest for knowledge base" already used
}

export interface Thread {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt?: number;
  titleEdited?: boolean;
  messages: Message[];
}

export const MODELS = ["MiniMax-M3", "MiniMax-M2.7"] as const;
export type Model = (typeof MODELS)[number];
export const DEFAULT_MODEL: Model = "MiniMax-M3";
