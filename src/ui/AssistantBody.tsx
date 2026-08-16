import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../state/types";

interface Props {
  message: Message;
  placeholder: string; // "…" while streaming with no content yet
}

type Block =
  | { type: "text"; text: string }
  | { type: "jargon"; text: string }
  | { type: "tryit"; text: string }
  | { type: "verify"; text: string };

function splitBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let buffer: string[] = [];

  function flush() {
    if (buffer.length) {
      blocks.push({ type: "text", text: buffer.join("\n") });
      buffer = [];
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("→")) {
      flush();
      blocks.push({ type: "jargon", text: trimmed.slice(1).trim() });
    } else if (trimmed.startsWith("Try it:")) {
      flush();
      blocks.push({ type: "tryit", text: trimmed });
    } else if (trimmed.startsWith("Verify:")) {
      flush();
      blocks.push({ type: "verify", text: trimmed });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

// Turn "[1]" into a markdown link to "#kb-cite-1" so ReactMarkdown renders it
// as an <a> we can intercept — but only outside fenced code, where a literal
// "[1]" is source text, not a citation.
function linkifyCitations(text: string): string {
  const segments = text.split("```");
  return segments.map((seg, i) => (i % 2 === 0 ? seg.replace(/\[(\d+)\]/g, "[$1](#kb-cite-$1)") : seg)).join("```");
}

function citeComponents(onCite: (n: number) => void) {
  return {
    a({ href, children }: { href?: string; children?: ReactNode }) {
      if (href?.startsWith("#kb-cite-")) {
        const n = Number(href.slice("#kb-cite-".length));
        return (
          <button type="button" className="assistant-cite" onClick={() => onCite(n)}>
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
}

export function AssistantBody({ message, placeholder }: Props) {
  const [openSource, setOpenSource] = useState<number | null>(null);
  const grounded = Boolean(message.grounded);
  const content = message.content || placeholder;
  const blocks = splitBlocks(content);
  const onCite = (n: number) => setOpenSource((prev) => (prev === n ? null : n));

  return (
    <div className="assistant-body">
      {message.mode && (
        <div className="assistant-body__badges">
          <span className={`assistant-badge assistant-badge--mode-${message.mode}`}>
            {message.mode === "tutor" ? "teach me" : "answer"}
          </span>
          <span className={`assistant-badge assistant-badge--${grounded ? "grounded" : "general"}`}>
            {grounded
              ? `grounded · ${message.corpusSources?.length ?? 0} source${(message.corpusSources?.length ?? 0) === 1 ? "" : "s"}`
              : "general knowledge — verify"}
          </span>
        </div>
      )}

      {blocks.map((block, i) => {
        const text = grounded ? linkifyCitations(block.text) : block.text;
        const markdown = (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={grounded ? citeComponents(onCite) : undefined}
          >
            {text}
          </ReactMarkdown>
        );
        if (block.type === "jargon") {
          return (
            <div key={i} className="assistant-callout assistant-callout--jargon">
              <span className="assistant-callout__label">jargon</span>
              {markdown}
            </div>
          );
        }
        if (block.type === "tryit") {
          return (
            <div key={i} className="assistant-callout assistant-callout--tryit">
              {markdown}
            </div>
          );
        }
        if (block.type === "verify") {
          return (
            <div key={i} className="assistant-callout assistant-callout--verify">
              {markdown}
            </div>
          );
        }
        return <div key={i}>{markdown}</div>;
      })}

      {message.corpusSources && message.corpusSources.length > 0 && (
        <div className="assistant-body__kb-sources">
          <span className="assistant-body__kb-sources-label">
            Knowledge base sources ({message.corpusSources.length})
          </span>
          <div className="assistant-body__kb-source-list">
            {message.corpusSources.map((s) => {
              const open = openSource === s.index;
              return (
                <div key={s.docId + s.index} className="assistant-kb-source">
                  <button
                    type="button"
                    className="assistant-kb-source__toggle"
                    onClick={() => onCite(s.index)}
                  >
                    <span className="assistant-kb-source__index">{s.index}</span>
                    <span className="assistant-kb-source__title">{s.title}</span>
                    {s.origin === "community" && (
                      <span className="assistant-kb-source__origin">reviewed answer</span>
                    )}
                    <span className="assistant-kb-source__hint">{open ? "hide" : "view"}</span>
                  </button>
                  {open && <div className="assistant-kb-source__text">{s.chunk}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
