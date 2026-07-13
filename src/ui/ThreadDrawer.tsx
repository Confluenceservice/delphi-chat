import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import type { Thread } from "../state/types";
import type { SyncStateMap } from "../state/sync";

interface Props {
  open: boolean;
  threads: Thread[];
  activeId: string | null;
  syncState?: SyncStateMap;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function ThreadDrawer({
  open,
  threads,
  activeId,
  syncState,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? threads.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
    : threads;

  return (
    <>
      <div className={`drawer-backdrop ${open ? "drawer-backdrop--open" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "drawer--open" : ""}`}>
        <button className="drawer__new" onClick={onNew}>
          <Plus size={16} strokeWidth={1.5} />
          New chat
        </button>
        <div className="drawer__search">
          <Search size={14} strokeWidth={1.5} />
          <input
            type="text"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search chats"
          />
        </div>
        <ul className="drawer__list">
          {filtered.map((t) => {
            const status = syncState?.[t.id];
            return (
              <li key={t.id} className={t.id === activeId ? "drawer__item drawer__item--active" : "drawer__item"}>
                <button className="drawer__item-title" onClick={() => onSelect(t.id)}>
                  {t.title || "New chat"}
                  {(status === "pending" || status === "error") && (
                    <span
                      className={`drawer__item-dot drawer__item-dot--${status}`}
                      aria-label={status === "pending" ? "Sync pending" : "Sync failed"}
                    />
                  )}
                </button>
                <button className="drawer__item-delete" onClick={() => onDelete(t.id)} aria-label="Delete chat">
                  <Trash2 size={15} strokeWidth={1.5} />
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </>
  );
}
