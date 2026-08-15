import { useCallback, useState } from "react";
import type { ChatMode } from "./types";

const MEMORY_ENABLED_KEY = "minimax-chat:memory-enabled";
const CHAT_MODE_KEY = "minimax-chat:chat-mode";

function loadMemoryEnabled(): boolean {
  const raw = localStorage.getItem(MEMORY_ENABLED_KEY);
  return raw === null ? true : raw === "true";
}

function loadChatMode(): ChatMode {
  const raw = localStorage.getItem(CHAT_MODE_KEY);
  return raw === "tutor" ? "tutor" : "answer";
}

export function useSettings() {
  const [memoryEnabled, setMemoryEnabledState] = useState(() => loadMemoryEnabled());
  const [chatMode, setChatModeState] = useState(() => loadChatMode());

  const setMemoryEnabled = useCallback((value: boolean) => {
    localStorage.setItem(MEMORY_ENABLED_KEY, String(value));
    setMemoryEnabledState(value);
  }, []);

  const setChatMode = useCallback((value: ChatMode) => {
    localStorage.setItem(CHAT_MODE_KEY, value);
    setChatModeState(value);
  }, []);

  return { memoryEnabled, setMemoryEnabled, chatMode, setChatMode };
}
