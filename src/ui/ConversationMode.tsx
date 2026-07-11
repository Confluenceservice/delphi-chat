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
  const [debug, setDebug] = useState({ frames: 0, prob: 0 });
  const [trace, setTrace] = useState<string>("waiting for speech…");
  const vadRef = useRef<VadHandle | null>(null);
  const stateRef = useRef<ConvState>("starting");
  // Diagnostic-only: proves whether mic audio is actually reaching the VAD
  // model at all, vs. reaching it but never crossing the speech threshold.
  const frameCountRef = useRef(0);
  const lastProbRef = useRef(0);
  // handleSend gets a new identity on every App render (it re-renders on
  // every streamed delta) — read the latest via ref so the VAD/mic lifecycle
  // below only ties to mount/unmount, not to that churn.
  const onUserUtteranceRef = useRef(onUserUtterance);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    onUserUtteranceRef.current = onUserUtterance;
  }, [onUserUtterance]);

  useEffect(() => {
    let cancelled = false;

    async function handleUtterance(wavBlob: Blob) {
      if (stateRef.current !== "listening") {
        setTrace(`speechEnd ignored (state=${stateRef.current})`);
        return; // ignore late/duplicate speech-end events
      }
      await vadRef.current?.pause();
      setState("thinking");
      try {
        setTrace(`transcribing ${Math.round(wavBlob.size / 1024)}KB…`);
        const transcript = await transcribeAudio(wavBlob, "audio/wav");
        if (!transcript.trim()) {
          setTrace("transcript was empty → back to listening");
          setState("listening");
          await vadRef.current?.start();
          return;
        }
        setTrace(`heard: "${transcript.slice(0, 40)}" → chat…`);
        const reply = await onUserUtteranceRef.current(transcript);
        if (!reply.trim()) {
          setTrace("chat reply empty → back to listening");
          setState("listening");
          await vadRef.current?.start();
          return;
        }
        setTrace("synthesizing speech…");
        setState("speaking");
        const audioBlob = await synthesizeSpeech(reply);
        await playBlob(audioBlob);
        setTrace("playing reply…");
        // resumed by the onPlaybackEnded listener below
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Something went wrong";
        setTrace(`error: ${msg}`);
        setError(msg);
        setState("listening");
        await vadRef.current?.start();
      }
    }

    async function init() {
      try {
        const { createVad } = await import("../audio/vad");
        const vad = await createVad({
          onSpeechStart: () => setTrace("speech started…"),
          onSpeechEnd: (wavBlob) => {
            setTrace(`speechEnd fired (${Math.round(wavBlob.size / 1024)}KB)`);
            void handleUtterance(wavBlob);
          },
          onFrameProcessed: (prob) => {
            frameCountRef.current += 1;
            lastProbRef.current = prob;
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

    const debugInterval = setInterval(() => {
      setDebug({ frames: frameCountRef.current, prob: lastProbRef.current });
    }, 300);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(debugInterval);
      void vadRef.current?.destroy();
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- VAD lifecycle
    // is intentionally mount/unmount only; see onUserUtteranceRef above.
  }, []);

  return (
    <div className="conversation-mode">
      <div className={`conversation-mode__orb conversation-mode__orb--${state}`} />
      <div className="conversation-mode__label">{LABELS[state]}</div>
      <div className="conversation-mode__debug">
        frames: {debug.frames} · p(speech): {debug.prob.toFixed(2)}
        <br />
        {trace}
      </div>
      {error && <div className="conversation-mode__error">{error}</div>}
      <button className="conversation-mode__stop" onClick={onClose}>
        Stop
      </button>
    </div>
  );
}
