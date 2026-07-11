export interface Env {
  ASSETS: Fetcher;
  MINIMAX_API_KEY: string;
  MINIMAX_BASE_URL: string;
  MINIMAX_GROUP_ID?: string;
  ASR_API_KEY: string;
  ASR_PROVIDER: string;
  ASR_BASE_URL: string;
  ASR_MODEL: string;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  DEV_USER_EMAIL?: string;
  ADMIN_EMAILS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}
