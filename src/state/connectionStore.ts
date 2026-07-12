export interface ConnectionState {
  authExpired: boolean;
  disconnected: boolean;
}

type Listener = () => void;

let state: ConnectionState = { authExpired: false, disconnected: false };
let lastFailedRequest: { input: RequestInfo | URL; init?: RequestInit } | null = null;
const listeners = new Set<Listener>();

function setState(patch: Partial<ConnectionState>) {
  const next = { ...state, ...patch };
  if (next.authExpired === state.authExpired && next.disconnected === state.disconnected) return;
  state = next;
  listeners.forEach((l) => l());
}

export const connectionStore = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ConnectionState {
    return state;
  },
  markAuthExpired() {
    setState({ authExpired: true });
  },
  markDisconnected(input: RequestInfo | URL, init?: RequestInit) {
    lastFailedRequest = { input, init };
    setState({ disconnected: true });
  },
  markConnected() {
    lastFailedRequest = null;
    setState({ authExpired: false, disconnected: false });
  },
  async retry() {
    if (!lastFailedRequest) {
      window.location.reload();
      return;
    }
    const { input, init } = lastFailedRequest;
    try {
      const response = await fetch(input, init);
      if (response.ok) {
        connectionStore.markConnected();
      } else if (response.status === 401 || response.status === 403) {
        connectionStore.markAuthExpired();
      }
    } catch {
      connectionStore.markDisconnected(input, init);
    }
  },
};
