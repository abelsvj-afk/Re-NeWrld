import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '../stores/auth';
import { getViewMode, setViewMode, type ViewMode } from '../lib/view-mode';

interface ViewToggleProps {
  /** Which view the toggle is currently displayed in. */
  current: ViewMode;
}

/**
 * Creator-only view switcher (H-UX3). Switches the UI view without
 * changing the account role — backend permissions are untouched.
 * Reader-only accounts never see this component.
 */
export function ViewToggle({ current }: ViewToggleProps) {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (user?.role !== 'creator') return null;

  const switchTo = (mode: ViewMode) => {
    if (mode === current) return;
    setViewMode(mode);
    navigate({ to: mode === 'creator' ? '/' : '/read' });
  };

  // Reflect a stale preference: if the stored mode disagrees with where
  // we are, trust the actual location.
  const active: ViewMode = getViewMode() ?? current;

  return (
    <div
      className="flex items-center rounded-lg border border-edge bg-abyss/60 p-0.5"
      role="group"
      aria-label="Switch view"
    >
      <button
        onClick={() => switchTo('creator')}
        aria-pressed={active === 'creator'}
        className={`text-xs font-medium px-3 py-1.5 rounded-md transition ${
          active === 'creator'
            ? 'bg-gradient-to-r from-arcane to-[#0ea5c4] text-void'
            : 'text-ink-dim hover:text-ink'
        }`}
      >
        ✦ Creator
      </button>
      <button
        onClick={() => switchTo('reader')}
        aria-pressed={active === 'reader'}
        className={`text-xs font-medium px-3 py-1.5 rounded-md transition ${
          active === 'reader'
            ? 'bg-gradient-to-r from-arcane to-[#0ea5c4] text-void'
            : 'text-ink-dim hover:text-ink'
        }`}
      >
        📖 Reader
      </button>
    </div>
  );
}
