/**
 * Storage health assertion (ADR-017, slice OPS-0).
 *
 * Detects whether a storage path (e.g. MEDIA_STORAGE_PATH) is backed by an
 * actual mounted filesystem (persistent Fly volume) or is merely a directory
 * on ephemeral disk. A missing mount is a silent failure: the app creates the
 * directory at startup and serves uploads from it, but a deploy wipes them.
 *
 * Design constraints (finalized spec v1.1):
 * - No writes on the health-request path. Writability is probed once at
 *   startup and the boolean is cached.
 * - The mount source is returned verbatim from the mount table; never
 *   hardcoded, never inferred. `null` when no mountpoint is detected.
 * - Unreadable mount table -> 'unknown', never a throw.
 * - Pure functions; no dependencies beyond node:fs / node:path.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface MountEntry {
  /** Mount source verbatim from the mount table (e.g. '/dev/vdb'). */
  device: string;
  /** Decoded mountpoint (e.g. '/data/media'). */
  mountpoint: string;
  fstype: string;
}

export type StorageState = 'ok' | 'degraded' | 'unknown';

export interface StorageHealth {
  state: StorageState;
  mountpoint: string;
  device: string | null;
  writable: boolean;
}

/**
 * Decode octal escape sequences used in /proc/self/mounts
 * (e.g. '\040' -> ' ', '\011' -> tab, '\012' -> newline, '\134' -> '\').
 * Returns null when an escape sequence is malformed.
 */
export function decodeEscapes(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      const seq = s.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(seq)) return null;
      out += String.fromCharCode(parseInt(seq, 8));
      i += 3;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Parse /proc/self/mounts text into entries.
 * Malformed lines (too few fields, bad escapes) are skipped, never fatal.
 */
export function parseMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    if (parts.length < 4) continue; // device, mountpoint, fstype, options, ...
    const mountpoint = decodeEscapes(parts[1]);
    if (mountpoint === null) continue;
    entries.push({ device: parts[0], mountpoint, fstype: parts[2] });
  }
  return entries;
}

/** Exact mountpoint match against decoded mountpoints. */
export function findMount(mounts: MountEntry[], mountpoint: string): MountEntry | null {
  for (const m of mounts) {
    if (m.mountpoint === mountpoint) return m;
  }
  return null;
}

/**
 * Evaluate storage health for a path.
 *
 * - 'ok': path is a real mountpoint on a device other than the root
 *   filesystem's device, and the startup write probe passed.
 * - 'degraded': path is not a mountpoint (ephemeral disk), is a bind-mount
 *   of the root filesystem, or the write probe failed.
 * - 'unknown': the mount table could not be read (mountsText === null).
 */
export function checkStorageHealth(
  mountsText: string | null,
  mountpoint: string,
  writable: boolean,
): StorageHealth {
  if (mountsText === null) {
    return { state: 'unknown', mountpoint, device: null, writable };
  }
  const mounts = parseMounts(mountsText);
  const entry = findMount(mounts, mountpoint);
  if (!entry) {
    return { state: 'degraded', mountpoint, device: null, writable };
  }
  // Root-filesystem bind-mount heuristic: the kernel reports a bind mount's
  // *source* device, so a bind-mount of ephemeral rootfs shares root's device
  // string. Scope note: device strings uniquely identify block devices
  // (/dev/vdX on Fly vs 'overlay' root), but pseudo-filesystems (tmpfs,
  // overlay) reuse strings across distinct instances. On Fly this cannot
  // false-positive a genuine volume; see the tmpfs boundary test.
  const root = findMount(mounts, '/');
  if (root && entry.device === root.device) {
    return { state: 'degraded', mountpoint, device: entry.device, writable };
  }
  if (!writable) {
    return { state: 'degraded', mountpoint, device: entry.device, writable };
  }
  return { state: 'ok', mountpoint, device: entry.device, writable };
}

/**
 * Map a storage state to the top-level /health status.
 * Explicit: 'unknown' is reported as 'unknown', never masked as 'ok'.
 * HTTP stays 200; the body communicates the uncertainty.
 */
export function toTopLevelStatus(state: StorageState): 'ok' | 'degraded' | 'unknown' {
  return state;
}

/** Read the mount table; returns null when unreadable. */
export function readMountTable(): string | null {
  try {
    return fs.readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return null;
  }
}

/**
 * Startup write probe: create -> fsync -> read -> delete a temp file.
 * Returns false (never throws) when the directory is not writable.
 * Call once at boot and cache the result; never call per-request.
 *
 * Safety: the probe file is created exclusively ('wx') with a
 * collision-resistant name, so it can never truncate a pre-existing file
 * (including one from another initialization in the same process). Cleanup
 * only removes the file this invocation successfully created.
 */
export function probeWritable(dir: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = path.join(
      dir,
      `.write-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    let created = false;
    try {
      const fd = fs.openSync(probe, 'wx');
      created = true;
      try {
        fs.writeSync(fd, 'ok');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.readFileSync(probe);
      return true;
    } catch (err) {
      // Name collision on exclusive create: retry with a fresh name.
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      return false;
    } finally {
      if (created) {
        try {
          fs.unlinkSync(probe);
        } catch {
          // Best effort cleanup; the probe result is what matters.
        }
      }
    }
  }
  return false;
}
