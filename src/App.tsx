import { useState } from "react";
import { streamChat, type ChatMessage } from "./api/chat";
import { useThreads } from "./state/useThreads";
import { DEFAULT_MODEL, type Message } from "./state/types";
import { stripThinking } from "./lib/thinking";
import { MessageList } from "./ui/MessageList";
import { Composer } from "./ui/Composer";
import { ModelPicker } from "./ui/ModelPicker";
import { ThreadDrawer } from "./ui/ThreadDrawer";
import { ConversationMode } from "./ui/ConversationMode";
import { unlockAudio } from "./audio/player";
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
    setThreadModel,
    appendMessage,
    updateMessage,
    newId,
  } = useThreads();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);

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

    return finalText;
  }

  return (
    <div className="app">
      <header className="app__header">
        <button className="app__menu" onClick={() => setDrawerOpen(true)} aria-label="Open chats">
          ☰
        </button>
        <span className="app__title">MiniMax Chat</span>
        <ModelPicker
          value={thread?.model ?? DEFAULT_MODEL}
          onChange={(model) => thread && setThreadModel(thread.id, model)}
        />
        <button
          className="app__conversation-toggle"
          onClick={() => {
            void unlockAudio();
            setConversationOpen(true);
          }}
          aria-label="Start conversation mode"
        >
          📞
        </button>
      </header>

      {error && <div className="app__error">{error}</div>}

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
    </div>
  );
}
