import { create } from 'zustand';

let seq = 0;

export const useToasts = create((set) => ({
  items: [],
  push(t) {
    const id = ++seq;
    set((s) => ({ items: [...s.items.slice(-3), { id, tone: 'info', ...t }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((i) => i.id !== id) })), t.durationMs || 6000);
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));

/** toast({ tone: 'success'|'warn'|'danger'|'info', title, message, to? }) */
export const toast = (t) => useToasts.getState().push(t);
