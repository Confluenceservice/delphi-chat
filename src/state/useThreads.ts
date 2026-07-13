import { useCallback, useEffect, useState } from "react";
import { loadActiveThreadId, loadThreads, saveActiveThreadId, saveThreads } from "./storage";
import { DEFAULT_MODEL, type Message, type Source, type Thread } from "./types";

function newId(): string {
  return crypto.randomUUID();
}

function newThread(): Thread {
  return {
    id: newId(),
    title: "New chat",
    model: DEFAULT_MODEL,
    createdAt: Date.now(),
    messages: [],
  };
}

export function useThreads() {
  const [threads, setThreads] = useState<Thread[]>(() => loadThreads());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const stored = loadActiveThreadId();
    const list = loadThreads();
    return stored && list.some((t) => t.id === stored) ? stored : (list[0]?.id ?? null);
  });

  useEffect(() => saveThreads(threads), [threads]);
  useEffect(() => saveActiveThreadId(activeId), [activeId]);

  const activeThread = threads.find((t) => t.id === activeId) ?? null;

  const createThread = useCallback(() => {
    const thread = newThread();
    setThreads((prev) => [thread, ...prev]);
    setActiveId(thread.id);
    return thread;
  }, []);

  const selectThread = useCallback((id: string) => setActiveId(id), []);

  const deleteThread = useCallback(
    (id: string) => {
      setThreads((prev) => prev.filter((t) => t.id !== id));
      setActiveId((current) => (current === id ? null : current));
    },
    [],
  );

  const setThreadModel = useCallback((id: string, model: string) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, model } : t)));
  }, []);

  const appendMessage = useCallback((threadId: string, message: Message) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t;
        const messages = [...t.messages, message];
        const title = t.messages.length === 0 && message.role === "user"
          ? message.content.slice(0, 40)
          : t.title;
        return { ...t, messages, title };
      }),
    );
  }, []);

  const updateMessage = useCallback((threadId: string, messageId: string, content: string) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t;
        return {
          ...t,
          messages: t.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
        };
      }),
    );
  }, []);

  const setMessageSources = useCallback(
    (threadId: string, messageId: string, sources: Source[]) => {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          return {
            ...t,
            messages: t.messages.map((m) =>
              m.id === messageId ? { ...m, sources } : m,
            ),
          };
        }),
      );
    },
    [],
  );

  return {
    threads,
    activeThread,
    activeId,
    createThread,
    selectThread,
    deleteThread,
    setThreadModel,
    appendMessage,
    updateMessage,
    setMessageSources,
    newId,
  };
}
