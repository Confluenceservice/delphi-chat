import { useEffect, useState } from "react";
import { Check, Database, Trash2, X as XIcon } from "lucide-react";
import {
  approveKbItem,
  deleteKbDoc,
  dismissKbItem,
  isForbidden,
  listKbDocs,
  listKbQueue,
  seedKb,
  type KbDocSummary,
  type KbQueueItem,
} from "../api/kb";

interface Props {
  open: boolean;
}

// Renders nothing for non-admins: a 403 on the queue fetch is the admin
// probe (no separate whoami endpoint). Admin-only, mounted as a Settings
// section.
export function KnowledgePanel({ open }: Props) {
  const [visible, setVisible] = useState(false);
  const [queue, setQueue] = useState<KbQueueItem[]>([]);
  const [docs, setDocs] = useState<KbDocSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    Promise.all([listKbQueue(), listKbDocs()])
      .then(([items, docList]) => {
        setVisible(true);
        setQueue(items);
        setDocs(docList);
      })
      .catch((err) => {
        if (isForbidden(err)) {
          setVisible(false);
          return;
        }
        setVisible(true);
        setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => setLoading(false));
  }, [open]);

  async function handleApprove(id: string) {
    const prev = queue;
    setQueue((q) => q.filter((item) => item.id !== id));
    try {
      await approveKbItem(id);
      setDocs(await listKbDocs());
    } catch (err) {
      setQueue(prev);
      setError(err instanceof Error ? err.message : "Failed to approve");
    }
  }

  async function handleDismiss(id: string) {
    const prev = queue;
    setQueue((q) => q.filter((item) => item.id !== id));
    try {
      await dismissKbItem(id);
    } catch (err) {
      setQueue(prev);
      setError(err instanceof Error ? err.message : "Failed to dismiss");
    }
  }

  async function handleDeleteDoc(id: string) {
    const prev = docs;
    setConfirmingDeleteId(null);
    setDocs((d) => d.filter((doc) => doc.id !== id));
    try {
      await deleteKbDoc(id);
    } catch (err) {
      setDocs(prev);
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleSeed() {
    setSeeding(true);
    try {
      await seedKb();
      setDocs(await listKbDocs());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to seed");
    } finally {
      setSeeding(false);
    }
  }

  if (!visible) return null;

  const pending = queue.filter((item) => item.status === "pending");

  return (
    <>
      <div className="settings-section">
        <div className="settings-section__title">Knowledge base review</div>
        <div className="settings-toggle__hint">
          Approved answers become citable sources for everyone — the text enters the
          system prompt for future turns, so review before approving.
        </div>

        {loading && <div className="settings-empty">Loading…</div>}
        {error && <div className="settings-error">{error}</div>}
        {!loading && pending.length === 0 && <div className="settings-empty">Nothing pending review.</div>}

        <ul className="kb-queue-list">
          {pending.map((item) => (
            <li key={item.id} className="kb-queue-list__item">
              <div className="kb-queue-list__question">{item.question}</div>
              <div className="kb-queue-list__answer">
                {item.answer.replace(/\[\d+\]|\*\*/g, "").slice(0, 220)}
                {item.answer.length > 220 ? "…" : ""}
              </div>
              <div className="kb-queue-list__meta">
                <span className="kb-queue-list__mode">{item.mode === "tutor" ? "teach me" : "answer"}</span>
                <span>suggested by {item.suggested_by}</span>
              </div>
              <div className="kb-queue-list__actions">
                <button className="kb-queue-list__approve" onClick={() => handleApprove(item.id)}>
                  <Check size={14} strokeWidth={1.5} /> Approve
                </button>
                <button className="kb-queue-list__dismiss" onClick={() => handleDismiss(item.id)}>
                  <XIcon size={14} strokeWidth={1.5} /> Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="settings-section">
        <div className="settings-section__title">Knowledge base documents ({docs.length})</div>

        {!docs.some((d) => d.origin === "seed") && (
          <button className="settings-account-action" onClick={handleSeed} disabled={seeding}>
            <Database size={14} strokeWidth={1.5} />
            {seeding ? "Seeding…" : "Seed knowledge base"}
          </button>
        )}

        {docs.length > 0 && (
          <ul className="memory-list">
            {docs.map((doc) => (
              <li key={doc.id} className="memory-list__item">
                <span>
                  {doc.title} · {doc.chunk_count} chunk{doc.chunk_count === 1 ? "" : "s"} ·{" "}
                  <span className="kb-doc-origin">{doc.origin}</span>
                </span>
                {confirmingDeleteId === doc.id ? (
                  <div className="settings-confirm">
                    <button className="settings-confirm__yes" onClick={() => handleDeleteDoc(doc.id)}>
                      Delete
                    </button>
                    <button className="settings-confirm__no" onClick={() => setConfirmingDeleteId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="memory-list__delete"
                    onClick={() => setConfirmingDeleteId(doc.id)}
                    aria-label="Delete document"
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
