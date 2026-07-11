import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { clearAllMemories, deleteMemoryFact, listMemories, type MemoryFact } from "../api/memory";

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

  useEffect(() => {
    if (!open) return;
    setConfirmingClear(false);
    setLoading(true);
    setError(null);
    listMemories()
      .then(setFacts)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [open]);

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
