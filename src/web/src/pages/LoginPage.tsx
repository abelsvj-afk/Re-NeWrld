import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../stores/auth';
import { ApiError, authApi } from '../lib/api';

type Mode = 'login' | 'register' | 'forgot' | 'reset';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('login');
  const [role, setRole] = useState<'creator' | 'reader'>('reader');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const { login, register } = useAuth();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
        window.location.href = '/';
      } else if (mode === 'register') {
        await register(email, password, role);
        window.location.href = '/';
      } else if (mode === 'forgot' && !resetSent) {
        await authApi.requestPasswordReset(email);
        setResetSent(true);
      } else {
        // forgot+resetSent or reset mode → confirm with token + new password
        await authApi.confirmPasswordReset(resetToken, newPassword);
        setResetDone(true);
      }
    } catch (err) {
      console.error('Auth failed:', err);
      let message = 'Something went wrong. Please try again.';
      if (err instanceof ApiError) {
        if (err.status === 401) message = 'Incorrect email or password. Please try again.';
        else if (err.status === 409) message = 'An account with this email already exists. Try signing in.';
        else if (err.status === 422 || err.status === 400) message = err.message || 'Please check your details and try again.';
        else message = err.message || message;
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-void relative overflow-hidden flex">
      {/* Atmospheric background */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(34,211,238,0.08),transparent)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_80%_110%,rgba(167,139,250,0.06),transparent)]" />
        {/* Subtle grid */}
        <div
          className="absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />
      </div>

      {/* Left: brand panel (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-[55%] relative flex-col justify-between p-12 xl:p-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-arcane to-voidlight flex items-center justify-center shadow-glow-cyan">
              <span className="text-void font-bold text-lg">R</span>
            </div>
            <span className="text-lg font-semibold tracking-tight">
              Re<span className="text-arcane">:</span>NeWrld
            </span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className="max-w-xl"
        >
          <p className="text-xs uppercase tracking-[0.3em] text-arcane/80 mb-6 font-medium">
            Interactive Fiction Platform
          </p>
          <h1 className="font-prose text-5xl xl:text-6xl leading-[1.1] mb-6 text-ink">
            Every choice<br />
            <span className="italic text-ink-dim">rewrites</span> the world.
          </h1>
          <p className="text-ink-dim text-lg leading-relaxed max-w-md">
            Craft branching narratives with cinematic depth. Readers shape the story —
            creators shape the universe.
          </p>

          <div className="flex gap-8 mt-12">
            {[
              ['Branching', 'Non-linear storytelling'],
              ['Canon', 'Immutable story truth'],
              ['Live', 'Real-time collaboration'],
            ].map(([title, desc]) => (
              <div key={title}>
                <p className="text-sm font-semibold text-ink mb-1">{title}</p>
                <p className="text-xs text-ink-dim">{desc}</p>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.4 }}
          className="text-xs text-ink-faint"
        >
          © 2026 Re:NeWrld — Stories that remember.
        </motion.p>
      </div>

      {/* Right: auth form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-12 relative">
        <motion.div
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[420px]"
        >
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-3 mb-10 justify-center">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-arcane to-voidlight flex items-center justify-center shadow-glow-cyan">
              <span className="text-void font-bold text-lg">R</span>
            </div>
            <span className="text-lg font-semibold tracking-tight">
              Re<span className="text-arcane">:</span>NeWrld
            </span>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={mode}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <h2 className="font-prose text-3xl mb-2">
                {mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Begin your journey' : mode === 'forgot' ? 'Reset password' : 'Set new password'}
              </h2>
              <p className="text-ink-dim text-sm mb-8">
                {mode === 'login'
                  ? 'Return to your stories — they\'ve been waiting.'
                  : mode === 'register'
                    ? 'Create your account to read and craft worlds.'
                    : mode === 'forgot'
                      ? resetSent
                        ? 'Check your email for a reset token, then enter it below.'
                        : 'Enter your email and we\'ll send a reset token.'
                      : 'Enter your reset token and choose a new password.'}
              </p>

              {(mode === 'forgot' || mode === 'reset') ? (
                <form onSubmit={submit} className="space-y-5">
                  {mode === 'forgot' && !resetSent && (
                    <div>
                      <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Email</label>
                      <input
                        type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com" autoComplete="email"
                        className="w-full bg-panel border border-edge rounded-xl px-4 py-3.5 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all"
                      />
                    </div>
                  )}
                  {(mode === 'reset' || (mode === 'forgot' && resetSent)) && (
                    <>
                      <div>
                        <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Reset token</label>
                        <input
                          value={resetToken} onChange={(e) => setResetToken(e.target.value)} required
                          placeholder="Paste the token from your email"
                          className="w-full bg-panel border border-edge rounded-xl px-4 py-3.5 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all font-mono text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">New password</label>
                        <input
                          type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="At least 8 characters" autoComplete="new-password"
                          className="w-full bg-panel border border-edge rounded-xl px-4 py-3.5 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all"
                        />
                      </div>
                    </>
                  )}
                  {error && <p className="text-blood text-sm bg-blood/10 border border-blood/25 rounded-xl px-4 py-3">{error}</p>}
                  {resetDone && <p className="text-emerald-300 text-sm bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-4 py-3">Password reset. You can now sign in.</p>}
                  {!resetDone && (
                    <button
                      type="submit" disabled={busy}
                      className="w-full bg-gradient-to-r from-arcane to-[#0ea5c4] text-void font-semibold rounded-xl px-4 py-3.5 hover:brightness-110 disabled:opacity-50 transition-all shadow-glow-cyan"
                    >
                      {busy ? 'Please wait…' : mode === 'forgot' && !resetSent ? 'Send reset token' : 'Set new password'}
                    </button>
                  )}
                  <div className="text-center">
                    <button type="button" onClick={() => { setMode('login'); setError(null); setResetSent(false); setResetDone(false); }} className="text-sm text-ink-dim hover:text-arcane transition-colors">
                      Back to sign in
                    </button>
                  </div>
                </form>
              ) : (
              <form onSubmit={submit} className="space-y-5">
                <div>
                  <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">
                    Email
                  </label>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-panel border border-edge rounded-xl px-4 py-3.5 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all"
                    placeholder="you@example.com"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-panel border border-edge rounded-xl px-4 py-3.5 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all"
                    placeholder="Enter your password"
                  />
                </div>

                {mode === 'register' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    transition={{ duration: 0.3 }}
                  >
                    <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">
                      I want to
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      {(['reader', 'creator'] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setRole(r)}
                          className={`rounded-xl px-4 py-4 text-sm font-medium border transition-all text-left ${
                            role === r
                              ? 'border-arcane bg-arcane/[0.08] text-ink shadow-glow-cyan'
                              : 'border-edge bg-panel text-ink-dim hover:border-edge-2 hover:text-ink'
                          }`}
                        >
                          <span className="block font-semibold mb-0.5">
                            {r === 'reader' ? 'Read' : 'Create'}
                          </span>
                          <span className="block text-xs opacity-70">
                            {r === 'reader' ? 'Explore living stories' : 'Build branching worlds'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}

                {error && (
                    <p className="text-blood text-sm bg-blood/10 border border-blood/25 rounded-xl px-4 py-3">
                      {error}
                    </p>
                  )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full bg-gradient-to-r from-arcane to-[#0ea5c4] text-void font-semibold rounded-xl px-4 py-3.5 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-glow-cyan"
                >
                  {busy ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-void/30 border-t-void rounded-full animate-spin" />
                      Please wait…
                    </span>
                  ) : mode === 'login' ? (
                    'Enter the world'
                  ) : (
                    'Create account'
                  )}
                </button>
              </form>
              )}

              <div className="mt-8 pt-6 border-t border-edge/60 text-center">
                <button
                  onClick={() => {
                    setMode(mode === 'login' ? 'register' : 'login');
                    setError(null);
                  }}
                  className="text-sm text-ink-dim hover:text-arcane transition-colors"
                >
                  {mode === 'login' ? (
                    <>Don&apos;t have an account? <span className="text-arcane font-medium">Create one</span></>
                  ) : (
                    <>Already have an account? <span className="text-arcane font-medium">Sign in</span></>
                  )}
                </button>
                {mode === 'login' && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => { setMode('forgot'); setError(null); }}
                      className="text-sm text-ink-faint hover:text-arcane transition-colors"
                    >
                      Forgot password?
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}
