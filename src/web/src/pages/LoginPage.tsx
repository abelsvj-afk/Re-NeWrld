import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '../stores/auth';
import { ApiError } from '../lib/api';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [role, setRole] = useState<'creator' | 'reader'>('reader');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, role);
      // Use window.location for reliable navigation after auth state change
      window.location.href = '/';
    } catch (err) {
      console.error('Auth failed:', err);
      const message = err instanceof ApiError 
        ? (err.message || `Request failed (${err.status})`)
        : 'Something went wrong. Please try again.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-void flex items-center justify-center p-6">
      <div className="glass rounded-2xl p-10 w-full max-w-md">
        <h1 className="text-3xl font-bold tracking-tight mb-1">
          Re<span className="text-arcane">:</span>NeWrld
        </h1>
        <p className="text-ink-dim text-sm mb-8">
          {mode === 'login' ? 'Return to your stories' : 'Begin your journey'}
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-widest text-ink-faint mb-2">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-abyss border border-edge rounded-lg px-4 py-3 text-ink placeholder:text-ink-faint focus:border-arcane focus:outline-none focus:ring-1 focus:ring-arcane/30 transition"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest text-ink-faint mb-2">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-abyss border border-edge rounded-lg px-4 py-3 text-ink placeholder:text-ink-faint focus:border-arcane focus:outline-none focus:ring-1 focus:ring-arcane/30 transition"
              placeholder="••••••••"
            />
          </div>

          {mode === 'register' && (
            <div className="grid grid-cols-2 gap-3">
              {(['reader', 'creator'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={`rounded-lg px-4 py-3 text-sm font-medium border transition ${
                    role === r
                      ? 'border-arcane bg-arcane/10 text-arcane'
                      : 'border-edge text-ink-dim hover:border-edge-2'
                  }`}
                >
                  {r === 'reader' ? 'Reader' : 'Creator'}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p className="text-blood text-sm bg-blood/10 border border-blood/20 rounded-lg px-4 py-3">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-arcane text-void font-semibold rounded-lg px-4 py-3 hover:bg-arcane/90 disabled:opacity-50 transition shadow-glow-cyan"
          >
            {busy ? 'Please wait…' : mode === 'login' ? 'Enter' : 'Create account'}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          className="mt-6 text-sm text-ink-dim hover:text-arcane transition w-full text-center"
        >
          {mode === 'login'
            ? "Don't have an account? Create one"
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
