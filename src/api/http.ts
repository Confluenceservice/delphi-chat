import { connectionStore } from "../state/connectionStore";

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    connectionStore.markDisconnected(input, init);
    throw err;
  }

  if (response.status === 401 || response.status === 403) {
    connectionStore.markAuthExpired();
  } else {
    connectionStore.markConnected();
  }

  return response;
}
