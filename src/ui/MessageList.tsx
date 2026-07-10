import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../state/types";

interface Props {
  messages: Message[];
  streaming: boolean;
}

export function MessageList({ messages, streaming }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="message-list__empty">Ask MiniMax anything.</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`message message--${m.role}`}>
          <div className="message__bubble">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {m.content || (streaming && m.role === "assistant" ? "…" : "")}
            </ReactMarkdown>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
