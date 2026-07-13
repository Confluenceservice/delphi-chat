import { useCallback, useEffect, useRef, useState } from "react";
import { loadActiveThreadId, loadThreads, saveActiveThreadId, saveThreads } from "./storage";
import { DEFAULT_MODEL, type Message, type Source, type Thread } from "./types";
import {
  markDeleted,
  markDirty,
  registerThreadSource,
  subscribe,
  type SyncStateMap,
} from "./sync";

function newId(): string {
  return crypto.randomUUID();
}

function newThread(): Thread {
  const now = Date.now();
  return {
    id: newId(),
    title: "New chat",
    model: DEFAULT_MODEL,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function touch(t: Thread): Thread {
  return { ...t, updatedAt: Date.now() };
}

export function useThreads() {
  const [threads, setThreads] = useState<Thread[]>(() => loadThreads());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const stored = loadActiveThreadId();
    const list = loadThreads();
    return stored && list.some((t) => t.id === stored) ? stored : (list[0]?.id ?? null);
  });
  const [syncState, setSyncState] = useState<SyncStateMap>({});

  useEffect(() => saveThreads(threads), [threads]);
  useEffect(() => saveActiveThreadId(activeId), [activeId]);

  // The sync engine reads threads through a ref so its debounced flush always
  // sees the latest state without re-registering on every render.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  useEffect(() => {
    registerThreadSource((id) => threadsRef.current.find((t) => t.id === id));
    return subscribe(setSyncState);
  }, []);

  const activeThread = threads.find((t) => t.id === activeId) ?? null;

  const createThread = useCallback(() => {
    const thread = newThread();
    setThreads((prev) => [thread, ...prev]);
    setActiveId(thread.id);
    markDirty(thread.id);
    return thread;
  }, []);

  const selectThread = useCallback((id: string) => setActiveId(id), []);

  const deleteThread = useCallback((id: string) => {
    setThreads((prev) => prev.filter((t) => t.id !== id));
    setActiveId((current) => (current === id ? null : current));
    markDeleted(id);
  }, []);

  const setThreadModel = useCallback((id: string, model: string) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? touch({ ...t, model }) : t)));
    markDirty(id);
  }, []);

  /**
   * Rename a thread. `manual` renames set titleEdited so auto-titling never
   * overwrites a name the user chose; auto-titles leave the flag unset.
   */
  const setThreadTitle = useCallback((id: string, title: string, manual: boolean) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (!manual && t.titleEdited) return t;
        return touch({ ...t, title, titleEdited: manual ? true : t.titleEdited });
      }),
    );
    markDirty(id);
  }, []);

  const appendMessage = useCallback((threadId: string, message: Message) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t;
        const messages = [...t.messages, message];
        const title = t.messages.length === 0 && message.role === "user"
          ? message.content.slice(0, 40)
          : t.title;
        return touch({ ...t, messages, title });
      }),
    );
    if (message.role === "user") markDirty(threadId);
    // Assistant placeholders sync via commitThread() when the stream settles.
  }, []);

  /** Streaming token updates: intentionally does NOT mark dirty. */
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

  /** Call when a stream settles (onDone/onError/abort) to push the final text. */
  const commitThread = useCallback((threadId: string) => {
    setThreads((prev) => prev.map((t) => (t.id === threadId ? touch(t) : t)));
    markDirty(threadId);
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
      // Sources arrive just before [DONE]; commitThread covers the sync.
    },
    [],
  );

  /** Edit-and-resend, linear semantics: drop the message and everything after. */
  const truncateFrom = useCallback((threadId: string, messageId: string) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t;
        const index = t.messages.findIndex((m) => m.id === messageId);
        if (index === -1) return t;
        return touch({ ...t, messages: t.messages.slice(0, index) });
      }),
    );
    markDirty(threadId);
  }, []);

  /** Regenerate: remove the trailing assistant reply (if any). */
  const dropLastAssistant = useCallback((threadId: string) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t;
        const last = t.messages[t.messages.length - 1];
        if (!last || last.role !== "assistant") return t;
        return touch({ ...t, messages: t.messages.slice(0, -1) });
      }),
    );
    markDirty(threadId);
  }, []);

  /** Applied by sync.reconcile(); remote data, so no markDirty. */
  const mergeRemoteThread = useCallback((thread: Thread) => {
    setThreads((prev) => {
      const exists = prev.some((t) => t.id === thread.id);
      const next = exists ? prev.map((t) => (t.id === thread.id ? thread : t)) : [thread, ...prev];
      return [...next].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
    });
  }, []);

  return {
    threads,
    activeThread,
    activeId,
    syncState,
    createThread,
    selectThread,
    deleteThread,
    setThreadModel,
    setThreadTitle,
    appendMessage,
    updateMessage,
    commitThread,
    setMessageSources,
    truncateFrom,
    dropLastAssistant,
    mergeRemoteThread,
    newId,
  };
}
