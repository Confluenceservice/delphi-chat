import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

interface Props {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled, onSend }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        className="composer__input"
        placeholder="Message MiniMax…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
      />
      <button
        className="composer__send"
        onClick={submit}
        disabled={disabled || !value.trim()}
        aria-label="Send message"
      >
        ↑
      </button>
    </div>
  );
}
