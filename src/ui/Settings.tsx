import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { clearAllMemories, deleteMemoryFact, listMemories, type MemoryFact } from "../api/memory";
import { getPersona, savePersona } from "../api/persona";

const PERSONA_MAX = 2000;

interface Props {
  open: boolean;
  memoryEnabled: boolean;
  onToggleMemory: (value: boolean) => void;
  onClose: () => void;
}

export function Settings({ open, memoryEnabled, onToggleMemory, onClose }: Props) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [persona, setPersona] = useState("");
  const [personaSaved, setPersonaSaved] = useState("");
  const [personaStatus, setPersonaStatus] = useState<"idle" | "saving" | "saved">("idle");

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
  }, [open]);

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
      </div>
    </div>
  );
}
