import { useRef, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { startRecording, stopRecording, cancelRecording } from "../audio/recorder";
import { transcribeAudio } from "../api/stt";

interface Props {
  disabled: boolean;
  onTranscript: (text: string) => void;
}

type MicState = "idle" | "starting" | "recording" | "transcribing";

export function MicButton({ disabled, onTranscript }: Props) {
  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | null>(null);
  const releasedEarly = useRef(false);

  async function handleStart() {
    if (disabled || state !== "idle") return;
    setError(null);
    releasedEarly.current = false;
    setState("starting");
    try {
      await startRecording();
      if (releasedEarly.current) {
        cancelRecording();
        setState("idle");
        return;
      }
      setState("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access denied");
      setState("idle");
    }
  }

  async function handleEnd() {
    if (state === "starting") {
      releasedEarly.current = true;
      return;
    }
    if (state !== "recording") return;
    setState("transcribing");
    try {
      const { blob, mimeType } = await stopRecording();
      const text = await transcribeAudio(blob, mimeType);
      if (text.trim()) onTranscript(text.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed");
    } finally {
      setState("idle");
    }
  }

  return (
    <div className="mic-button-wrap">
      <button
        className={`mic-button ${state !== "idle" ? "mic-button--active" : ""}`}
        disabled={disabled || state === "transcribing"}
        onPointerDown={handleStart}
        onPointerUp={handleEnd}
        onPointerLeave={handleEnd}
        onPointerCancel={handleEnd}
        aria-label="Hold to talk"
      >
        {state === "transcribing" ? (
          <Loader2 size={18} strokeWidth={1.5} className="animate-spin" />
        ) : (
          <Mic size={18} strokeWidth={1.5} />
        )}
      </button>
      {error && <div className="mic-button__error">{error}</div>}
    </div>
  );
}
