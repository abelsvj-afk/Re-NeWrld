/**
 * Kernel-backed file locking via the `flock(1)` binary.
 *
 * Node.js has no built-in flock. This module uses child processes running
 * `flock` to hold real kernel advisory locks (LOCK_SH / LOCK_EX).
 *
 * Lock acquisition is VERIFIED via /proc/locks (B5): we poll for the child
 * PID holding the lock on the target inode. A process that is still alive
 * but waiting for the lock does NOT count as acquired.
 *
 * The kernel releases locks when the holder process dies (crash-safe).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

export class FlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlockError';
  }
}

export interface LockHandle {
  /** The child process holding the lock. Kill to release. */
  process: ChildProcess;
  /** PID of the holder (for /proc/locks verification). */
  pid: number;
  /** Device major of the locked file (for /proc/locks verification). */
  major: number;
  /** Device minor of the locked file (for /proc/locks verification). */
  minor: number;
  /** Inode of the locked file (for /proc/locks verification). */
  inode: number;
  /** Path being locked. */
  path: string;
  /** Lock mode. */
  mode: 'shared' | 'exclusive';
}

/**
 * Checks /proc/locks for a lock held by pid on inode.
 * Returns the lock mode ('ADVISORY', 'FLOCK') or null if not found.
 */
/**
 * Gets the device major, minor, and inode for a path via stat(1).
 * Uses '%t %T %i' for hex major, hex minor, decimal inode.
 */
async function getFileIdentity(path: string): Promise<{ major: number; minor: number; inode: number }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('stat', ['-c', '%t %T %i', path]);
  const [majorHex, minorHex, inodeStr] = stdout.trim().split(/\s+/);
  return {
    major: parseInt(majorHex, 16),
    minor: parseInt(minorHex, 16),
    inode: parseInt(inodeStr, 10),
  };
}

async function checkProcLocks(
  pid: number,
  major: number,
  minor: number,
  inode: number,
): Promise<string | null> {
  try {
    const content = await readFile('/proc/locks', 'utf-8');
    // Format: "1: FLOCK  ADVISORY  WRITE 1234 00:00:12345 0 EOF"
    // Fields: id, type, mode, access, pid, dev:ino, start, end
    // dev:ino is "major:minor:inode" in hex:hex:decimal
    for (const line of content.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const lockPid = parseInt(parts[4], 10);
      const devIno = parts[5];
      const m = devIno.match(/^([0-9a-f]+):([0-9a-f]+):(\d+)$/i);
      if (!m) continue;
      const lockMajor = parseInt(m[1], 16);
      const lockMinor = parseInt(m[2], 16);
      const lockIno = parseInt(m[3], 10);
      // B5 (rev 2): Compare major, minor, AND inode separately.
      // The old (major << 8) | minor encoding is not the general Linux
      // dev_t layout; extended device numbers would be misidentified.
      if (lockPid === pid && lockMajor === major && lockMinor === minor && lockIno === inode) {
        return parts[1]; // lock type (FLOCK)
      }
    }
  } catch (err) {
    if (err instanceof FlockError) throw err;
    // /proc/locks not available (non-Linux). Fail closed.
    throw new FlockError('/proc/locks not available; cannot verify lock acquisition');
  }
  return null;
}

/**
 * Waits for the lock to appear in /proc/locks, up to timeoutMs.
 * Throws FlockError on timeout or if the process exits.
 */
async function waitForLock(
  child: ChildProcess,
  pid: number,
  major: number,
  minor: number,
  inode: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  const pollInterval = 50;

  while (Date.now() - start < timeoutMs) {
    // Check if process exited.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new FlockError(
        `flock process exited with code ${child.exitCode} before acquiring lock (already locked)`,
      );
    }

    // Check /proc/locks.
    const found = await checkProcLocks(pid, major, minor, inode);
    if (found) return; // Lock confirmed.

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Timeout: kill the waiter and throw.
  child.kill('SIGKILL');
  throw new FlockError(`Timeout waiting for lock acquisition on inode ${inode} (${timeoutMs}ms)`);
}

/**
 * Acquires an exclusive non-blocking lock on a path.
 *
 * @throws FlockError if the lock is already held.
 */
export async function acquireExclusiveNonBlocking(path: string): Promise<LockHandle> {
  const fileStat = await stat(path).catch(async () => {
    // File may not exist; create it first.
    const { open } = await import('node:fs/promises');
    const fh = await open(path, 'w', 0o644);
    await fh.close();
    return stat(path);
  });
  const { major, minor, inode } = await getFileIdentity(path);

  const child = spawn('flock', ['-n', path, 'sleep', 'infinity'], { stdio: 'ignore' });

  // B5: Attach error listener BEFORE checking pid. If spawn fails, the
  // 'error' event fires; without a listener it becomes an unhandled rejection.
  const spawnErrorPromise = new Promise<Error | null>((resolve) => {
    child.on('error', (err) => resolve(err));
  });

  const pid = child.pid;
  if (!pid) {
    // Spawn failed synchronously; wait for the error event.
    const err = await Promise.race([
      spawnErrorPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);
    throw new FlockError(`Failed to spawn flock: ${err?.message ?? 'unknown'}`);
  }

  // Check for async spawn error (e.g., ENOENT for missing binary).
  const spawnError = await Promise.race([
    spawnErrorPromise,
    new Promise<null>((r) => setTimeout(() => r(null), 50)),
  ]);
  if (spawnError) {
    throw new FlockError(`Failed to spawn flock: ${spawnError.message}`);
  }

  try {
    // For non-blocking, the process exits immediately if locked.
    // Wait for lock confirmation with a short timeout.
    await waitForLock(child, pid, major, minor, inode, 2000);
  } catch (err) {
    // Ensure child is dead.
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw err;
  }

  return { process: child, pid, major, minor, inode, path, mode: 'exclusive' };
}

/**
 * Acquires a shared lock on a path (blocking, with timeout).
 * Used for per-chunk fencing: hold during validate+write.
 */
export async function acquireShared(path: string, timeoutMs: number = 10000): Promise<LockHandle> {
  const fileStat = await stat(path);
  const { major, minor, inode } = await getFileIdentity(path);

  const child = spawn('flock', ['-s', path, 'sleep', 'infinity'], { stdio: 'ignore' });

  // B5: Attach error listener before pid check.
  const spawnErrorPromise = new Promise<Error | null>((resolve) => {
    child.on('error', (err) => resolve(err));
  });

  const pid = child.pid;
  if (!pid) {
    const err = await Promise.race([
      spawnErrorPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);
    throw new FlockError(`Failed to spawn flock: ${err?.message ?? 'unknown'}`);
  }

  const spawnError = await Promise.race([
    spawnErrorPromise,
    new Promise<null>((r) => setTimeout(() => r(null), 50)),
  ]);
  if (spawnError) {
    throw new FlockError(`Failed to spawn flock: ${spawnError.message}`);
  }

  try {
    // Wait for the lock to actually be acquired (not just process alive).
    await waitForLock(child, pid, major, minor, inode, timeoutMs);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw err;
  }

  return { process: child, pid, major, minor, inode, path, mode: 'shared' };
}

/**
 * Releases a lock by killing the holder process.
 * Waits for the process to actually exit (B5: does not resolve early).
 */
export async function releaseLock(handle: LockHandle): Promise<void> {
  const proc = handle.process;
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return; // Already dead.
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Force kill if still alive after 2s.
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } catch { /* ignore */ }
    }, 2000);

    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Executes a function while holding a shared lock on a path.
 * The lock is released when the function completes or throws.
 */
export async function withSharedLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireShared(path);
  try {
    return await fn();
  } finally {
    await releaseLock(handle);
  }
}
