/**
 * Creator/Reader view preference (H-UX3).
 * Pure UI preference — never touches the account role or permissions.
 * Stored in localStorage; corrupted values fall back to null (role default).
 */

const VIEW_MODE_KEY = 'renewrld:view-mode';

export type ViewMode = 'creator' | 'reader';

export function getViewMode(): ViewMode | null {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY);
    if (raw === 'creator' || raw === 'reader') return raw;
    return null;
  } catch {
    return null;
  }
}

export function setViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Storage unavailable (private mode, etc.) — preference just won't persist.
  }
}

export function clearViewMode(): void {
  try {
    localStorage.removeItem(VIEW_MODE_KEY);
  } catch {
    // No-op
  }
}
