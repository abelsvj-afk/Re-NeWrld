import { create } from 'zustand';
import { authApi, setAuthToken, type User } from '../lib/api';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, role: 'creator' | 'reader') => Promise<void>;
  logout: () => void;
  hydrate: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

  login: async (email, password) => {
    const { token, user } = await authApi.login(email, password);
    setAuthToken(token);
    set({ user, loading: false });
  },

  register: async (email, password, role) => {
    const { token, user } = await authApi.register(email, password, role);
    setAuthToken(token);
    set({ user, loading: false });
  },

  logout: () => {
    setAuthToken(null);
    set({ user: null });
  },

  hydrate: async () => {
    try {
      const user = await authApi.me();
      set({ user, loading: false });
    } catch {
      setAuthToken(null);
      set({ user: null, loading: false });
    }
  },
}));
