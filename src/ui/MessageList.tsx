import { useEffect, useRef, useState } from "react";
import { Copy, Pencil, RotateCcw, Square, Volume2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../state/types";
import { synthesizeSpeech } from "../api/tts";
import { playBlob, stopPlayback } from "../audio/player";

interface Props {
  messages: Message[];
  streaming: boolean;
  onEdit?: (messageId: string) => void;
  onRegenerate?: () => void;
}

export function MessageList({ messages, streaming, onEdit, onRegenerate }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [speakError, setSpeakError] = useState<{ id: string; message: string } | null>(null);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  async function handleCopy(content: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // clipboard unavailable; nothing to fall back to
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  async function handleSpeak(message: Message) {
    if (speakingId === message.id) {
      stopPlayback();
      setSpeakingId(null);
      return;
    }
    setSpeakError(null);
    setSpeakingId(message.id);
    try {
      const blob = await synthesizeSpeech(message.content);
      await playBlob(blob);
    } catch (err) {
      setSpeakError({ id: message.id, message: err instanceof Error ? err.message : "Speech failed" });
      setSpeakingId(null);
      return;
    }
    setSpeakingId(null);
  }

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="message-list__empty">Ask MiniMax anything.</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`message message--${m.role}`}>
          <div className="message__bubble">
            {m.images && m.images.length > 0 && (
              <div className="message__images">
                {m.images.map((src, i) => (
                  <img key={i} src={src} alt="" className="message__image" />
                ))}
              </div>
            )}
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {m.content || (streaming && m.role === "assistant" ? "…" : "")}
            </ReactMarkdown>
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <div className="message__sources">
                <span className="message__sources-label">Sources</span>
                <ul>
                  {m.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title || s.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="message__actions">
              <button
                className="message__action"
                onClick={() => handleCopy(m.content)}
                aria-label="Copy message"
              >
                <Copy size={14} strokeWidth={1.5} />
              </button>
              {m.role === "user" && onEdit && (
                <button
                  className="message__action"
                  onClick={() => onEdit(m.id)}
                  aria-label="Edit message"
                >
                  <Pencil size={14} strokeWidth={1.5} />
                </button>
              )}
              {m.role === "assistant" && m.id === lastAssistantId && onRegenerate && !streaming && (
                <button
                  className="message__action"
                  onClick={onRegenerate}
                  aria-label="Regenerate response"
                >
                  <RotateCcw size={14} strokeWidth={1.5} />
                </button>
              )}
              {m.role === "assistant" && m.content && (
                <button
                  className="message__action"
                  onClick={() => handleSpeak(m)}
                  aria-label={speakingId === m.id ? "Stop speaking" : "Read aloud"}
                >
                  {speakingId === m.id ? (
                    <Square size={14} strokeWidth={1.5} />
                  ) : (
                    <Volume2 size={14} strokeWidth={1.5} />
                  )}
                </button>
              )}
            </div>
          </div>
          {speakError?.id === m.id && (
            <div className="message__speak-error">{speakError.message}</div>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
