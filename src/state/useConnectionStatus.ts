import { useSyncExternalStore } from "react";
import { connectionStore } from "./connectionStore";

export function useConnectionStatus() {
  return useSyncExternalStore(connectionStore.subscribe, connectionStore.getSnapshot);
}
