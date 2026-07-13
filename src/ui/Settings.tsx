import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Trash2, Volume2, X } from "lucide-react";
import { clearAllMemories, deleteMemoryFact, listMemories, type MemoryFact } from "../api/memory";
import { getPersona, savePersona } from "../api/persona";
import { getVoice, saveVoice } from "../api/voice";
import { synthesizeSpeech } from "../api/tts";
import { playBlob } from "../audio/player";
import { DEFAULT_VOICE_ID, VOICES } from "../data/voices";
import { logout } from "../lib/auth";
import { clearCacheAndReload } from "../lib/cache";
import type { Thread } from "../state/types";

const PERSONA_MAX = 2000;
const VOICE_PREVIEW_TEXT = "Hi! This is how I'll sound when I read replies aloud.";

interface Props {
  open: boolean;
  memoryEnabled: boolean;
  onToggleMemory: (value: boolean) => void;
  onClose: () => void;
  threads: Thread[];
  onImportThreads: (threads: Thread[]) => void;
}

export function Settings({ open, memoryEnabled, onToggleMemory, onClose, threads, onImportThreads }: Props) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [persona, setPersona] = useState("");
  const [personaSaved, setPersonaSaved] = useState("");
  const [personaStatus, setPersonaStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [voiceId, setVoiceId] = useState<string>(DEFAULT_VOICE_ID);
  const [previewing, setPreviewing] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setConfirmingClear(false);
    setLoading(true);
    setError(null);
    setPersonaStatus("idle");
    listMemories()
      .then(setFacts)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
    getPersona()
      .then((p) => {
        setPersona(p);
        setPersonaSaved(p);
      })
      .catch(() => {});
    getVoice()
      .then((v) => setVoiceId(v ?? DEFAULT_VOICE_ID))
      .catch(() => {});
  }, [open]);

  async function handleVoiceChange(id: string) {
    setVoiceId(id);
    try {
      await saveVoice(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save voice");
    }
  }

  async function handlePreviewVoice() {
    setPreviewing(true);
    try {
      const blob = await synthesizeSpeech(VOICE_PREVIEW_TEXT, voiceId);
      await playBlob(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSavePersona() {
    setPersonaStatus("saving");
    try {
      await savePersona(persona);
      setPersonaSaved(persona);
      setPersonaStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save persona");
      setPersonaStatus("idle");
    }
  }

  async function handleDelete(id: string) {
    const prev = facts;
    setFacts((f) => f.filter((fact) => fact.id !== id));
    try {
      await deleteMemoryFact(id);
    } catch (err) {
      setFacts(prev);
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleClearAll() {
    const prev = facts;
    setFacts([]);
    setConfirmingClear(false);
    try {
      await clearAllMemories();
    } catch (err) {
      setFacts(prev);
      setError(err instanceof Error ? err.message : "Failed to clear");
    }
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(threads, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `delphi-chat-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error("Not a valid export file");
      onImportThreads(parsed as Thread[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  }

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-panel__header">
          <span>Settings</span>
          <button className="settings-panel__close" onClick={onClose} aria-label="Close settings">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-section__title">Persona</div>
          <div className="settings-toggle__hint">
            Tell MiniMax how to behave — its tone, role, or style. Applies to every
            conversation.
          </div>
          <textarea
            className="persona-input"
            placeholder="e.g. You are a concise, friendly cooking assistant. Prefer metric units."
            value={persona}
            maxLength={PERSONA_MAX}
            onChange={(e) => {
              setPersona(e.target.value);
              if (personaStatus === "saved") setPersonaStatus("idle");
            }}
            rows={4}
          />
          <div className="persona-actions">
            <span className="persona-count">
              {persona.length}/{PERSONA_MAX}
            </span>
            <button
              className="persona-save"
              onClick={handleSavePersona}
              disabled={personaStatus === "saving" || persona === personaSaved}
            >
              {personaStatus === "saving" ? "Saving…" : personaStatus === "saved" ? "Saved ✓" : "Save"}
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section__title">Voice</div>
          <div className="settings-toggle__hint">
            Used for read-aloud and conversation mode.
          </div>
          <div className="voice-row">
            <select
              className="voice-select"
              value={voiceId}
              onChange={(e) => handleVoiceChange(e.target.value)}
              aria-label="Voice"
            >
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} ({v.gender})
                </option>
              ))}
            </select>
            <button
              className="voice-preview"
              onClick={handlePreviewVoice}
              disabled={previewing}
              aria-label="Preview voice"
            >
              <Volume2 size={16} strokeWidth={1.5} />
              {previewing ? "Playing…" : "Preview"}
            </button>
          </div>
        </div>

        <div className="settings-section">
          <label className="settings-toggle">
            <span>
              Remember things about me
              <div className="settings-toggle__hint">
                MiniMax can recall facts you've shared across conversations
              </div>
            </span>
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(e) => onToggleMemory(e.target.checked)}
            />
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section__title">What MiniMax remembers</div>

          {loading && <div className="settings-empty">Loading…</div>}
          {error && <div className="settings-error">{error}</div>}
          {!loading && !error && facts.length === 0 && (
            <div className="settings-empty">Nothing remembered yet.</div>
          )}

          <ul className="memory-list">
            {facts.map((fact) => (
              <li key={fact.id} className="memory-list__item">
                <span>{fact.text}</span>
                <button
                  className="memory-list__delete"
                  onClick={() => handleDelete(fact.id)}
                  aria-label="Forget this"
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
              </li>
            ))}
          </ul>

          {facts.length > 0 &&
            (confirmingClear ? (
              <div className="settings-confirm">
                <span>Forget everything?</span>
                <button className="settings-confirm__yes" onClick={handleClearAll}>
                  Yes, clear all
                </button>
                <button className="settings-confirm__no" onClick={() => setConfirmingClear(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="settings-clear-all" onClick={() => setConfirmingClear(true)}>
                Clear all memory
              </button>
            ))}
        </div>

        <div className="settings-section">
          <div className="settings-section__title">Conversations</div>
          <div className="settings-account-actions">
            <button className="settings-account-action" onClick={handleExport}>
              Export chats
            </button>
            <button className="settings-account-action" onClick={() => importInputRef.current?.click()}>
              Import chats
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={handleImportFile}
            />
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section__title">Account</div>
          <div className="settings-account-actions">
            <button className="settings-account-action" onClick={() => void clearCacheAndReload()}>
              Clear cache &amp; reload
            </button>
            <button className="settings-account-action settings-account-action--danger" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
