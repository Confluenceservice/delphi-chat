import { useState } from "react";
import { streamChat } from "./api/chat";
import { useThreads } from "./state/useThreads";
import { DEFAULT_MODEL } from "./state/types";
import { MessageList } from "./ui/MessageList";
import { Composer } from "./ui/Composer";
import { ModelPicker } from "./ui/ModelPicker";
import { ThreadDrawer } from "./ui/ThreadDrawer";
import "./App.css";

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

  const thread = activeThread ?? null;

  function ensureThread() {
    return thread ?? createThread();
  }

  async function handleSend(text: string) {
    const t = ensureThread();
    setError(null);

    appendMessage(t.id, { id: newId(), role: "user", content: text });
    const assistantId = newId();
    appendMessage(t.id, { id: assistantId, role: "assistant", content: "" });

    const history = [...t.messages, { id: "", role: "user" as const, content: text }].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setStreaming(true);
    let assistantText = "";

    await streamChat({
      model: t.model,
      messages: history,
      onDelta: (delta) => {
        assistantText += delta;
        updateMessage(t.id, assistantId, assistantText);
      },
      onDone: () => setStreaming(false),
      onError: (message) => {
        setStreaming(false);
        setError(message);
        updateMessage(t.id, assistantId, assistantText || `⚠️ ${message}`);
      },
    });
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
      </header>

      {error && <div className="app__error">{error}</div>}

      <main className="app__main">
        <MessageList messages={thread?.messages ?? []} streaming={streaming} />
      </main>

      <footer className="app__footer">
        <Composer disabled={streaming} onSend={handleSend} />
      </footer>

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
