import { useCallback, useState } from "react";

const MEMORY_ENABLED_KEY = "minimax-chat:memory-enabled";

function loadMemoryEnabled(): boolean {
  const raw = localStorage.getItem(MEMORY_ENABLED_KEY);
  return raw === null ? true : raw === "true";
}

export function useSettings() {
  const [memoryEnabled, setMemoryEnabledState] = useState(() => loadMemoryEnabled());

  const setMemoryEnabled = useCallback((value: boolean) => {
    localStorage.setItem(MEMORY_ENABLED_KEY, String(value));
    setMemoryEnabledState(value);
  }, []);

  return { memoryEnabled, setMemoryEnabled };
}
