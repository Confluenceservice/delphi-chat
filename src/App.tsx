import { useEffect, useRef, useState } from "react";
import { Menu, Phone, Settings2, X } from "lucide-react";
import { streamChat, type ChatMessage } from "./api/chat";
import { useThreads } from "./state/useThreads";
import { useSettings } from "./state/useSettings";
import { markDirty, reconcile } from "./state/sync";
import { fetchTitle } from "./api/threads";
import { type Message, type Thread } from "./state/types";
import { suggestForKb } from "./api/kb";
import { stripThinking } from "./lib/thinking";
import { MessageList } from "./ui/MessageList";
import { Composer } from "./ui/Composer";
import { ThreadDrawer } from "./ui/ThreadDrawer";
import { ConversationMode } from "./ui/ConversationMode";
import { Settings } from "./ui/Settings";
import { ConnectionBanner } from "./ui/ConnectionBanner";
import { unlockAudio } from "./audio/player";
import { ingestMemory } from "./api/memory";
import "./App.css";

function toApiMessage(m: Message): ChatMessage {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content };
  }
  return {
    role: m.role,
    content: [
      { type: "text", text: m.content },
      ...m.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ],
  };
}

export default function App() {
  const {
    threads,
    activeThread,
    activeId,
    syncState,
    createThread,
    selectThread,
    deleteThread,
    setThreadTitle,
    appendMessage,
    updateMessage,
    commitThread,
    setMessageSources,
    setMessageKbMeta,
    markMessageSuggested,
    truncateFrom,
    dropLastAssistant,
    mergeRemoteThread,
    newId,
  } = useThreads();
  const { memoryEnabled, setMemoryEnabled, chatMode, setChatMode } = useSettings();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<{ id: string; text: string; images?: string[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const thread = activeThread ?? null;

  useEffect(() => {
    void reconcile(threads, mergeRemoteThread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ensureThread() {
    return thread ?? createThread();
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  async function runStream(
    t: Thread,
    assistantId: string,
    history: ChatMessage[],
    userText: string,
    wasEmpty: boolean,
  ): Promise<string> {
    setStreaming(true);
    abortRef.current = new AbortController();
    let rawText = "";
    let finalText = "";

    await streamChat({
      model: t.model,
      messages: history,
      memory: memoryEnabled,
      mode: chatMode,
      signal: abortRef.current.signal,
      onDelta: (delta) => {
        rawText += delta;
        finalText = stripThinking(rawText);
        updateMessage(t.id, assistantId, finalText);
      },
      onSources: (sources) => setMessageSources(t.id, assistantId, sources),
      onKbMeta: (meta) => setMessageKbMeta(t.id, assistantId, meta),
      onDone: () => {
        setStreaming(false);
        commitThread(t.id);
      },
      onError: (message) => {
        setStreaming(false);
        setError(message);
        finalText = stripThinking(rawText);
        updateMessage(t.id, assistantId, finalText || `⚠️ ${message}`);
        commitThread(t.id);
      },
    });

    // streamChat resolves silently on abort (no onDone/onError), so make sure
    // the partial text still gets pushed to D1.
    setStreaming(false);
    commitThread(t.id);

    const aborted = abortRef.current?.signal.aborted ?? false;
    if (!aborted && memoryEnabled && finalText.trim() && !finalText.includes("⚠️")) {
      ingestMemory(userText, finalText);
    }
    if (!aborted && wasEmpty && finalText.trim()) {
      void fetchTitle(userText, finalText).then((title) => {
        if (title) setThreadTitle(t.id, title, false);
      });
    }

    return finalText;
  }

  async function handleSend(text: string, images?: string[]): Promise<string> {
    const t = ensureThread();
    setError(null);

    const userMessage: Message = { id: newId(), role: "user", content: text, images };
    appendMessage(t.id, userMessage);
    const assistantId = newId();
    appendMessage(t.id, { id: assistantId, role: "assistant", content: "" });

    const history = [...t.messages, userMessage].map(toApiMessage);
    const wasEmpty = t.messages.length === 0;

    return runStream(t, assistantId, history, text, wasEmpty);
  }

  function handleImportThreads(imported: Thread[]) {
    for (const t of imported) {
      mergeRemoteThread(t);
      markDirty(t.id);
    }
  }

  function handleEdit(messageId: string) {
    const m = thread?.messages.find((x) => x.id === messageId);
    if (!m || !thread) return;
    setEditDraft({ id: messageId, text: m.content, images: m.images });
  }

  async function submitEdit(text: string, images?: string[]): Promise<string> {
    if (!thread || !editDraft) return "";
    truncateFrom(thread.id, editDraft.id);
    setEditDraft(null);
    return handleSend(text, images);
  }

  async function handleRegenerate() {
    if (!thread || streaming) return;
    const messages = thread.messages;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;

    const historyMessages = messages.slice(0, -1);
    const lastUser = [...historyMessages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;

    dropLastAssistant(thread.id);
    const assistantId = newId();
    appendMessage(thread.id, { id: assistantId, role: "assistant", content: "" });

    const history = historyMessages.map(toApiMessage);
    await runStream(thread, assistantId, history, lastUser.content, false);
  }

  return (
    <div className="app">
      <header className="app__header">
        <button className="app__menu" onClick={() => setDrawerOpen(true)} aria-label="Open chats">
          <Menu size={20} strokeWidth={1.5} />
        </button>
        <span className="app__title">Delphi Chat</span>
        <div className="app__mode-toggle" role="group" aria-label="Response mode">
          <button
            className="app__mode-option"
            aria-pressed={chatMode === "answer"}
            onClick={() => setChatMode("answer")}
          >
            Answer
          </button>
          <button
            className="app__mode-option"
            aria-pressed={chatMode === "tutor"}
            onClick={() => setChatMode("tutor")}
          >
            Teach me
          </button>
        </div>
        <button
          className="app__conversation-toggle"
          onClick={() => {
            void unlockAudio();
            setConversationOpen(true);
          }}
          aria-label="Start conversation mode"
        >
          <Phone size={18} strokeWidth={1.5} />
        </button>
        <button
          className="app__settings-toggle"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
        >
          <Settings2 size={18} strokeWidth={1.5} />
        </button>
      </header>

      <ConnectionBanner />

      {error && (
        <div className="app__error">
          <span>{error}</span>
          <button className="app__error-dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}

      <main className="app__main">
        <MessageList
          messages={thread?.messages ?? []}
          streaming={streaming}
          onEdit={handleEdit}
          onRegenerate={handleRegenerate}
          onSuggestForKb={(messageId) => {
            if (!thread) return;
            const idx = thread.messages.findIndex((m) => m.id === messageId);
            const assistantMsg = thread.messages[idx];
            const question = thread.messages.slice(0, idx).reverse().find((m) => m.role === "user")?.content;
            if (!assistantMsg || !question) return;
            suggestForKb(question, assistantMsg.content, assistantMsg.mode ?? "answer");
            markMessageSuggested(thread.id, messageId);
          }}
        />
      </main>

      <footer className="app__footer">
        <Composer
          disabled={streaming}
          onSend={editDraft ? submitEdit : handleSend}
          streaming={streaming}
          onStop={handleStop}
          editDraft={editDraft}
          onCancelEdit={() => setEditDraft(null)}
        />
      </footer>

      {conversationOpen && (
        <ConversationMode
          onUserUtterance={(text) => handleSend(text)}
          onClose={() => setConversationOpen(false)}
        />
      )}

      <ThreadDrawer
        open={drawerOpen}
        threads={threads}
        activeId={activeId}
        syncState={syncState}
        onSelect={(id) => {
          selectThread(id);
          setDrawerOpen(false);
        }}
        onNew={() => {
          createThread();
          setDrawerOpen(false);
        }}
        onDelete={deleteThread}
        onClose={() => setDrawerOpen(false)}
      />

      <Settings
        open={settingsOpen}
        memoryEnabled={memoryEnabled}
        onToggleMemory={setMemoryEnabled}
        onClose={() => setSettingsOpen(false)}
        threads={threads}
        onImportThreads={handleImportThreads}
      />
    </div>
  );
}
