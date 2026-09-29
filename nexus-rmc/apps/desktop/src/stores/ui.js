import { create } from 'zustand';
import { platform } from '../services/platform.js';

/** Per-user UI preferences (theme, sidebar). Kept in localStorage; never security-relevant. */
const read = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
};

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  platform.setTheme(theme);
}

export const useUi = create((set, get) => ({
  theme: read('nexus.theme', 'light'),
  sidebarCollapsed: read('nexus.sidebarCollapsed', '0') === '1',

  toggleTheme() {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    write('nexus.theme', theme);
    applyTheme(theme);
    set({ theme });
  },

  toggleSidebar() {
    const sidebarCollapsed = !get().sidebarCollapsed;
    write('nexus.sidebarCollapsed', sidebarCollapsed ? '1' : '0');
    set({ sidebarCollapsed });
  },
}));
