import { Plus, Trash2 } from "lucide-react";
import type { Thread } from "../state/types";

interface Props {
  open: boolean;
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function ThreadDrawer({ open, threads, activeId, onSelect, onNew, onDelete, onClose }: Props) {
  return (
    <>
      <div className={`drawer-backdrop ${open ? "drawer-backdrop--open" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "drawer--open" : ""}`}>
        <button className="drawer__new" onClick={onNew}>
          <Plus size={16} strokeWidth={1.5} />
          New chat
        </button>
        <ul className="drawer__list">
          {threads.map((t) => (
            <li key={t.id} className={t.id === activeId ? "drawer__item drawer__item--active" : "drawer__item"}>
              <button className="drawer__item-title" onClick={() => onSelect(t.id)}>
                {t.title || "New chat"}
              </button>
              <button className="drawer__item-delete" onClick={() => onDelete(t.id)} aria-label="Delete chat">
                <Trash2 size={15} strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
