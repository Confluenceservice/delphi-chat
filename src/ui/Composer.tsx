import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { MicButton } from "./MicButton";

interface EditDraft {
  id: string;
  text: string;
  images?: string[];
}

interface Props {
  disabled: boolean;
  onSend: (text: string, images?: string[]) => void;
  streaming?: boolean;
  onStop?: () => void;
  editDraft?: EditDraft | null;
  onCancelEdit?: () => void;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // MiniMax vision limit

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({ disabled, onSend, streaming, onStop, editDraft, onCancelEdit }: Props) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editDraft) return;
    setValue(editDraft.text);
    setImages(editDraft.images ?? []);
    textareaRef.current?.focus();
  }, [editDraft]);

  function cancelEdit() {
    onCancelEdit?.();
    setValue("");
    setImages([]);
  }

  function submit() {
    const text = value.trim();
    if ((!text && images.length === 0) || disabled) return;
    onSend(text, images.length > 0 ? images : undefined);
    setValue("");
    setImages([]);
    setImageError(null);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setImageError(null);

    const oversized = files.find((f) => f.size > MAX_IMAGE_BYTES);
    if (oversized) {
      setImageError(`${oversized.name} is over the 10MB limit`);
      return;
    }

    const dataUrls = await Promise.all(files.map(fileToDataUrl));
    setImages((prev) => [...prev, ...dataUrls]);
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="composer__previews">
          {images.map((src, i) => (
            <div key={i} className="composer__preview">
              <img src={src} alt="" />
              <button
                className="composer__preview-remove"
                onClick={() => removeImage(i)}
                aria-label="Remove image"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      )}
      {editDraft && (
        <div className="composer__editing">
          <span>Editing message</span>
          <button className="composer__editing-cancel" onClick={cancelEdit} aria-label="Cancel edit">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
      {imageError && <div className="composer__error">{imageError}</div>}
      <div className="composer__row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={handleFiles}
        />
        <button
          className="composer__attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label="Attach image"
        >
          <Paperclip size={18} strokeWidth={1.5} />
        </button>
        <textarea
          ref={textareaRef}
          className="composer__input"
          placeholder="Message Delphi…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <MicButton disabled={disabled} onTranscript={(text) => onSend(text)} />
        {streaming ? (
          <button className="composer__send" onClick={onStop} aria-label="Stop generating">
            <Square size={18} strokeWidth={1.5} />
          </button>
        ) : (
          <button
            className="composer__send"
            onClick={submit}
            disabled={disabled || (!value.trim() && images.length === 0)}
            aria-label="Send message"
          >
            <Send size={18} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </div>
  );
}
