/**
 * Kernel-backed file locking via the `flock(1)` binary.
 *
 * Node.js has no built-in flock. This module uses child processes running
 * `flock` to hold real kernel advisory locks (LOCK_SH / LOCK_EX).
 *
 * - Ownership lock: `flock -n <lockfile> sleep infinity` held in a child process.
 *   Non-blocking; exits non-zero if already locked → WRITER_CONFLICT.
 * - Per-chunk shared lock: `flock -s <path> sleep infinity` held during validate+write.
 *
 * The kernel releases locks when the holder process dies (crash-safe).
 */

import { spawn, type ChildProcess } from 'node:child_process';

export class FlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlockError';
  }
}

export interface LockHandle {
  /** The child process holding the lock. Kill to release. */
  process: ChildProcess;
  /** Path being locked. */
  path: string;
  /** Lock mode. */
  mode: 'shared' | 'exclusive';
}

/**
 * Acquires an exclusive non-blocking lock on a path.
 * Spawns `flock -n <path> sleep infinity` and verifies it stays alive.
 *
 * @throws FlockError if the lock is already held (EWOULDBLOCK equivalent).
 */
export async function acquireExclusiveNonBlocking(path: string): Promise<LockHandle> {
  return acquireLock(path, 'exclusive', true);
}

/**
 * Acquires a shared lock on a path (blocking).
 * Used for per-chunk fencing: hold during validate+write.
 */
export async function acquireShared(path: string): Promise<LockHandle> {
  return acquireLock(path, 'shared', false);
}

async function acquireLock(
  path: string,
  mode: 'shared' | 'exclusive',
  nonBlocking: boolean,
): Promise<LockHandle> {
  const args: string[] = [];
  if (nonBlocking) args.push('-n');
  if (mode === 'shared') args.push('-s');
  // -x is default (exclusive).
  args.push(path, 'sleep', 'infinity');

  const child = spawn('flock', args, { stdio: 'ignore' });

  // Wait briefly to see if it exits (lock contention).
  const exited = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 100);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exited !== null) {
    // Process exited → lock not acquired.
    throw new FlockError(
      `Failed to acquire ${mode} lock on ${path}: flock exited with code ${exited} (already locked)`,
    );
  }

  // Still running → lock held.
  return { process: child, path, mode };
}

/**
 * Releases a lock by killing the holder process.
 * The kernel releases the lock when the process dies.
 */
export async function releaseLock(handle: LockHandle): Promise<void> {
  return new Promise((resolve) => {
    const proc = handle.process;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(); // Already dead.
      return;
    }
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    // Fallback: SIGKILL after 1s.
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      resolve();
    }, 1000);
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
