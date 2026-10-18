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
  /** Path of the locked file (for verification). */
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
 * Verifies that a process holds a flock on the target file.
 *
 * B5 (final): Uses fstat on /proc/<pid>/fd entries to get dev+ino directly.
 * Compares against Node's stat(dev, ino) — no device-number encoding,
 * no string path matching. If verification cannot be completed, fails closed.
 *
 * Steps:
 * 1. Get target file's (dev, ino) via Node stat.
 * 2. List /proc/<pid>/fd; for each fd, fstat /proc/<pid>/fd/<n> to get (dev, ino).
 * 3. If any fd's (dev, ino) matches the target → the process has the file open.
 * 4. Check /proc/locks for a FLOCK entry with this PID and matching inode.
 *    (Confirms it's a flock, not just an open fd.)
 * Both checks must pass. Otherwise, fail closed.
 */
async function verifyLockHeld(pid: number, targetPath: string): Promise<boolean> {
  const { stat: fstat } = await import('node:fs/promises');

  // Step 1: Get target identity via Node stat (dev and ino as numbers, no encoding).
  let targetDev: number, targetIno: number;
  try {
    const st = await fstat(targetPath);
    targetDev = st.dev;
    targetIno = st.ino;
  } catch (err) {
    throw new FlockError(`Cannot stat target ${targetPath}: ${(err as Error).message}`);
  }

  // Step 2: Check the process's open FDs via fstat on /proc/<pid>/fd/<n>.
  // This gives us (dev, ino) in the same numeric space as Node's stat.
  let fdMatches = false;
  try {
    const { readdir } = await import('node:fs/promises');
    const fds = await readdir(`/proc/${pid}/fd`);
    for (const fd of fds) {
      try {
        const fdStat = await fstat(`/proc/${pid}/fd/${fd}`);
        // Compare dev AND ino (not just ino — inodes aren't unique across filesystems).
        if (fdStat.dev === targetDev && fdStat.ino === targetIno) {
          fdMatches = true;
          break;
        }
      } catch {
        continue; // FD may have closed; try next.
      }
    }
  } catch (err) {
    // Cannot read /proc/<pid>/fd → fail closed. Do NOT fall back to true.
    throw new FlockError(
      `Cannot verify open FDs for pid ${pid}: ${(err as Error).message}; failing closed`
    );
  }

  if (!fdMatches) {
    // Process does not have the target file open → lock not held on our file.
    return false;
  }

  // Step 3: Confirm a FLOCK entry exists for this PID on the exact (dev, ino).
  // /proc/locks shows device as "major:minor" in hex. We encode it to dev_t
  // using Linux new_encode_dev and compare against Node's stat.dev.
  // This closes the ambiguity where PID holds a flock on a different file
  // with the same inode number on another filesystem.
  try {
    const locksContent = await readFile('/proc/locks', 'utf-8');
    for (const line of locksContent.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      // Format: "1: FLOCK  ADVISORY  WRITE 1234 00:51:893 0 EOF"
      if (parts[1] !== 'FLOCK') continue;
      const lockPid = parseInt(parts[4], 10);
      if (lockPid !== pid) continue;
      const dm = parts[5].match(/^([0-9a-f]+):([0-9a-f]+):(\d+)$/i);
      if (!dm) continue;
      const lockMajor = parseInt(dm[1], 16);
      const lockMinor = parseInt(dm[2], 16);
      const lockIno = parseInt(dm[3], 10);
      // Encode (major, minor) to dev_t via Linux new_encode_dev.
      const lockDev = encodeDev(lockMajor, lockMinor);
      if (lockDev === targetDev && lockIno === targetIno) {
        return true; // Confirmed: PID holds a FLOCK on the exact (dev, ino).
      }
    }
  } catch (err) {
    throw new FlockError(`/proc/locks unavailable: ${(err as Error).message}; failing closed`);
  }

  return false;
}

/**
 * Encodes (major, minor) to a Linux dev_t using new_encode_dev.
 * Formula: (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12)
 * This matches what the kernel reports via stat().st_dev for the
 * device numbers shown in /proc/locks.
 */
function encodeDev(major: number, minor: number): number {
  return (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12);
}

/**
 * Waits for the lock to appear in /proc/locks, up to timeoutMs.
 * Throws FlockError on timeout or if the process exits.
 */
async function waitForLock(
  child: ChildProcess,
  pid: number,
  targetPath: string,
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
    const found = await verifyLockHeld(pid, targetPath);
    if (found) return; // Lock confirmed.

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Timeout: kill the waiter and throw.
  child.kill('SIGKILL');
  throw new FlockError(`Timeout waiting for lock acquisition on ${targetPath} (${timeoutMs}ms)`);
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
  // Note: we don't need the inode here; verifyLockHeld gets it via stat.

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
    await waitForLock(child, pid, path, 2000);
  } catch (err) {
    // Ensure child is dead.
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw err;
  }

  return { process: child, pid, path, mode: 'exclusive' };
}

/**
 * Acquires a shared lock on a path (blocking, with timeout).
 * Used for per-chunk fencing: hold during validate+write.
 */
export async function acquireShared(path: string, timeoutMs: number = 10000): Promise<LockHandle> {
  const fileStat = await stat(path);
  // Note: we don't need the inode here; verifyLockHeld gets it via stat.

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
    await waitForLock(child, pid, path, timeoutMs);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw err;
  }

  return { process: child, pid, path, mode: 'shared' };
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
