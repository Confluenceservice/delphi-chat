import { useConnectionStatus } from "../state/useConnectionStatus";
import { connectionStore } from "../state/connectionStore";
import { logout } from "../lib/auth";

export function ConnectionBanner() {
  const { authExpired, disconnected } = useConnectionStatus();

  if (!authExpired && !disconnected) return null;

  if (authExpired) {
    return (
      <div className="connection-banner">
        <span>Session expired</span>
        <button className="connection-banner__action" onClick={logout}>
          Log in again
        </button>
      </div>
    );
  }

  return (
    <div className="connection-banner">
      <span>Connection lost</span>
      <button className="connection-banner__action" onClick={() => connectionStore.retry()}>
        Retry
      </button>
    </div>
  );
}
