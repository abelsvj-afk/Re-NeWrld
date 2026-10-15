import { create } from 'zustand';
import { authApi, type User } from '../lib/api';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, role: 'creator' | 'reader') => Promise<void>;
  logout: () => void;
  hydrate: () => Promise<void>;
  becomeCreator: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

  login: async (email, password) => {
    const user = await authApi.login(email, password);
    set({ user, loading: false });
  },

  register: async (email, password, role) => {
    const user = await authApi.register(email, password, role);
    set({ user, loading: false });
  },

  logout: async () => {
    try { await authApi.logout(); } catch { /* ignore */ }
    set({ user: null });
    window.location.href = '/login';
  },

  hydrate: async () => {
    try {
      const user = await authApi.me();
      set({ user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },

  becomeCreator: async () => {
    const user = await authApi.becomeCreator();
    set({ user, loading: false });
  },
}));
