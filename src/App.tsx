import { useState } from "react";
import { Menu, Phone, Settings2, X } from "lucide-react";
import { streamChat, type ChatMessage } from "./api/chat";
import { useThreads } from "./state/useThreads";
import { useSettings } from "./state/useSettings";
import { type Message } from "./state/types";
import { stripThinking } from "./lib/thinking";
import { MessageList } from "./ui/MessageList";
import { Composer } from "./ui/Composer";
import { ThreadDrawer } from "./ui/ThreadDrawer";
import { ConversationMode } from "./ui/ConversationMode";
import { Settings } from "./ui/Settings";
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
    createThread,
    selectThread,
    deleteThread,
    appendMessage,
    updateMessage,
    newId,
  } = useThreads();
  const { memoryEnabled, setMemoryEnabled } = useSettings();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const thread = activeThread ?? null;

  function ensureThread() {
    return thread ?? createThread();
  }

  async function handleSend(text: string, images?: string[]): Promise<string> {
    const t = ensureThread();
    setError(null);

    const userMessage: Message = { id: newId(), role: "user", content: text, images };
    appendMessage(t.id, userMessage);
    const assistantId = newId();
    appendMessage(t.id, { id: assistantId, role: "assistant", content: "" });

    const history = [...t.messages, userMessage].map(toApiMessage);

    setStreaming(true);
    let rawText = "";
    let finalText = "";

    await streamChat({
      model: t.model,
      messages: history,
      memory: memoryEnabled,
      onDelta: (delta) => {
        rawText += delta;
        finalText = stripThinking(rawText);
        updateMessage(t.id, assistantId, finalText);
      },
      onDone: () => setStreaming(false),
      onError: (message) => {
        setStreaming(false);
        setError(message);
        finalText = stripThinking(rawText);
        updateMessage(t.id, assistantId, finalText || `⚠️ ${message}`);
      },
    });

    if (memoryEnabled && finalText.trim()) {
      ingestMemory(text, finalText);
    }

    return finalText;
  }

  return (
    <div className="app">
      <header className="app__header">
        <button className="app__menu" onClick={() => setDrawerOpen(true)} aria-label="Open chats">
          <Menu size={20} strokeWidth={1.5} />
        </button>
        <span className="app__title">Dephi Chat</span>
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

      {error && (
        <div className="app__error">
          <span>{error}</span>
          <button className="app__error-dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}

      <main className="app__main">
        <MessageList messages={thread?.messages ?? []} streaming={streaming} />
      </main>

      <footer className="app__footer">
        <Composer disabled={streaming} onSend={handleSend} />
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
      />
    </div>
  );
}
