import { useEffect, useRef, useState } from "react";
import type { VadHandle } from "../audio/vad";
import { transcribeAudio } from "../api/stt";
import { synthesizeSpeech } from "../api/tts";
import { playBlob, onPlaybackEnded, stopPlayback } from "../audio/player";

type ConvState = "starting" | "listening" | "thinking" | "speaking" | "error";

interface Props {
  onUserUtterance: (text: string) => Promise<string>;
  onClose: () => void;
}

const LABELS: Record<ConvState, string> = {
  starting: "Starting…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

export function ConversationMode({ onUserUtterance, onClose }: Props) {
  const [state, setState] = useState<ConvState>("starting");
  const [error, setError] = useState<string | null>(null);
  const vadRef = useRef<VadHandle | null>(null);
  const stateRef = useRef<ConvState>("starting");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;

    async function handleUtterance(wavBlob: Blob) {
      if (stateRef.current !== "listening") return; // ignore late/duplicate speech-end events
      await vadRef.current?.pause();
      setState("thinking");
      try {
        const transcript = await transcribeAudio(wavBlob, "audio/wav");
        if (!transcript.trim()) {
          setState("listening");
          await vadRef.current?.start();
          return;
        }
        const reply = await onUserUtterance(transcript);
        if (!reply.trim()) {
          setState("listening");
          await vadRef.current?.start();
          return;
        }
        setState("speaking");
        const audioBlob = await synthesizeSpeech(reply);
        await playBlob(audioBlob);
        // resumed by the onPlaybackEnded listener below
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
        setState("listening");
        await vadRef.current?.start();
      }
    }

    async function init() {
      try {
        const { createVad } = await import("../audio/vad");
        const vad = await createVad({
          onSpeechStart: () => {},
          onSpeechEnd: (wavBlob) => {
            void handleUtterance(wavBlob);
          },
        });
        if (cancelled) {
          await vad.destroy();
          return;
        }
        vadRef.current = vad;
        await vad.start();
        setState("listening");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Microphone unavailable");
        setState("error");
      }
    }

    init();

    const unsubscribe = onPlaybackEnded(() => {
      if (stateRef.current === "speaking") {
        setState("listening");
        void vadRef.current?.start();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      void vadRef.current?.destroy();
      stopPlayback();
    };
  }, [onUserUtterance]);

  return (
    <div className="conversation-mode">
      <div className={`conversation-mode__orb conversation-mode__orb--${state}`} />
      <div className="conversation-mode__label">{LABELS[state]}</div>
      {error && <div className="conversation-mode__error">{error}</div>}
      <button className="conversation-mode__stop" onClick={onClose}>
        Stop
      </button>
    </div>
  );
}
