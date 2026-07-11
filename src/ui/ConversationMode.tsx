import { useEffect, useRef, useState } from "react";
import { createVad, type VadHandle } from "../audio/vad";
import { transcribeAudio } from "../api/stt";
import { synthesizeSpeech } from "../api/tts";
import { playBlob, onPlaybackEnded, stopPlayback } from "../audio/player";

type ConvState = "starting" | "listening" | "thinking" | "speaking" | "error";

interface Props {
  onUserUtterance: (text: string) => Promise<string>;
  onClose: () => void;
}

// Bump on every conversation-mode deploy so we can confirm on-device that the
// latest code is actually running (vs. a stale service-worker-cached shell).
const BUILD = __BUILD__;

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
  const [debug, setDebug] = useState({ frames: 0, prob: 0, silence: 0 });
  const [trace, setTrace] = useState<string>("waiting for speech…");
  const vadRef = useRef<VadHandle | null>(null);
  const stateRef = useRef<ConvState>("starting");
  const frameCountRef = useRef(0);
  const lastProbRef = useRef(0);
  const lastSilenceRef = useRef(0);
  const misfireCountRef = useRef(0);
  // handleSend gets a new identity on every App render (it re-renders on every
  // streamed delta) — read the latest via ref so the VAD/mic lifecycle below
  // only ties to mount/unmount, not to that churn.
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
      await vadRef.current?.pause(); // stop listening while we think + speak (no barge-in)
      setState("thinking");
      try {
        setTrace(`transcribing ${Math.round(wavBlob.size / 1024)}KB…`);
        const transcript = await transcribeAudio(wavBlob, "audio/wav");
        if (!transcript.trim()) {
          setTrace("transcript empty → listening");
          setState("listening");
          await vadRef.current?.start();
          return;
        }
        setTrace(`heard: "${transcript.slice(0, 40)}" → chat…`);
        const reply = await onUserUtteranceRef.current(transcript);
        if (!reply.trim()) {
          setTrace("reply empty → listening");
          setState("listening");
          await vadRef.current?.start();
          return;
        }
        setTrace("speaking reply…");
        setState("speaking");
        const audioBlob = await synthesizeSpeech(reply);
        await playBlob(audioBlob);
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
        const vad = await createVad({
          onSpeechStart: () => setTrace("speech started…"),
          onSpeechEnd: (wavBlob) => {
            setTrace(`speechEnd (${Math.round(wavBlob.size / 1024)}KB)`);
            void handleUtterance(wavBlob);
          },
          onMisfire: () => {
            misfireCountRef.current += 1;
            setTrace(`misfire #${misfireCountRef.current} (too short) — ignored`);
          },
          onError: (msg) => setTrace(`endpoint error: ${msg}`),
          onFrameProcessed: (prob, silenceMs) => {
            frameCountRef.current += 1;
            lastProbRef.current = prob;
            lastSilenceRef.current = silenceMs;
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
      setDebug({
        frames: frameCountRef.current,
        prob: lastProbRef.current,
        silence: lastSilenceRef.current,
      });
    }, 300);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(debugInterval);
      void vadRef.current?.destroy();
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- VAD lifecycle is
    // intentionally mount/unmount only; see onUserUtteranceRef above.
  }, []);

  return (
    <div className="conversation-mode">
      <div className={`conversation-mode__orb conversation-mode__orb--${state}`} />
      <div className="conversation-mode__label">{LABELS[state]}</div>
      <div className="conversation-mode__debug">
        [{BUILD}] frames: {debug.frames} · p: {debug.prob.toFixed(2)} · silence:{" "}
        {Math.round(debug.silence)}ms
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
