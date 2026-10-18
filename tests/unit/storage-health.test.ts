import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeEscapes,
  parseMounts,
  findMount,
  checkStorageHealth,
  probeWritable,
  readMountTable,
  toTopLevelStatus,
} from '../../src/shared/storage/storage-health.js';

describe('decodeEscapes', () => {
  it('decodes space, tab, newline, backslash escapes', () => {
    expect(decodeEscapes('/data/my\\040media')).toBe('/data/my media');
    expect(decodeEscapes('/data/tab\\011here')).toBe('/data/tab\there');
    expect(decodeEscapes('/data/new\\012line')).toBe('/data/new\nline');
    expect(decodeEscapes('/data/back\\134slash')).toBe('/data/back\\slash');
  });

  it('leaves plain strings untouched', () => {
    expect(decodeEscapes('/data/media')).toBe('/data/media');
    expect(decodeEscapes('')).toBe('');
  });

  it('returns null for truncated escapes', () => {
    expect(decodeEscapes('/data/bad\\04')).toBeNull();
    expect(decodeEscapes('/data/bad\\0')).toBeNull();
    expect(decodeEscapes('/data/bad\\')).toBeNull();
  });

  it('returns null for non-octal escapes', () => {
    expect(decodeEscapes('/data/bad\\999')).toBeNull();
    expect(decodeEscapes('/data/bad\\89a')).toBeNull();
  });
});

describe('parseMounts', () => {
  it('parses standard mount table lines', () => {
    const text =
      '/dev/vdb /data/media ext4 rw,relatime 0 0\n' +
      'overlay / overlay rw,relatime 0 0\n';
    const entries = parseMounts(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ device: '/dev/vdb', mountpoint: '/data/media', fstype: 'ext4' });
    expect(entries[1]).toEqual({ device: 'overlay', mountpoint: '/', fstype: 'overlay' });
  });

  it('decodes escaped mountpoints', () => {
    const text = '/dev/vdb /data/my\\040media ext4 rw 0 0\n';
    const entries = parseMounts(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].mountpoint).toBe('/data/my media');
  });

  it('skips malformed lines without failing', () => {
    const text =
      '/dev/vdb /data/media ext4 rw 0 0\n' +
      'too-few-fields\n' +
      '\n' +
      '/dev/vdc /data/bad\\04 ext4 rw 0 0\n' +
      '/dev/vdd /data/other xfs rw 0 0\n';
    const entries = parseMounts(text);
    expect(entries.map((e) => e.mountpoint)).toEqual(['/data/media', '/data/other']);
  });

  it('returns empty array for empty input', () => {
    expect(parseMounts('')).toEqual([]);
  });
});

describe('findMount', () => {
  const mounts = parseMounts('/dev/vdb /data/media ext4 rw 0 0\noverlay / overlay rw 0 0\n');

  it('finds exact matches', () => {
    expect(findMount(mounts, '/data/media')?.device).toBe('/dev/vdb');
    expect(findMount(mounts, '/')?.device).toBe('overlay');
  });

  it('does not match path prefixes', () => {
    expect(findMount(mounts, '/data/media2')).toBeNull();
    expect(findMount(mounts, '/data')).toBeNull();
  });

  it('returns null when absent', () => {
    expect(findMount(mounts, '/nope')).toBeNull();
    expect(findMount([], '/data/media')).toBeNull();
  });
});

describe('checkStorageHealth', () => {
  const healthyTable =
    'overlay / overlay rw 0 0\n' + '/dev/vdb /data/media ext4 rw 0 0\n';
  const ephemeralTable = 'overlay / overlay rw 0 0\n';

  it('reports ok for a real volume mount', () => {
    const h = checkStorageHealth(healthyTable, '/data/media', true);
    expect(h).toEqual({
      state: 'ok',
      mountpoint: '/data/media',
      device: '/dev/vdb',
      writable: true,
    });
  });

  it('returns the device verbatim, never hardcoded', () => {
    const table = 'overlay / overlay rw 0 0\n/dev/nvme0n1 /data/media ext4 rw 0 0\n';
    const h = checkStorageHealth(table, '/data/media', true);
    expect(h.device).toBe('/dev/nvme0n1');
  });

  it('reports degraded when the path is not a mountpoint', () => {
    const h = checkStorageHealth(ephemeralTable, '/data/media', true);
    expect(h.state).toBe('degraded');
    expect(h.device).toBeNull();
  });

  it('reports degraded for a bind-mount of the root filesystem', () => {
    const table = 'overlay / overlay rw 0 0\noverlay /data/media overlay rw 0 0\n';
    const h = checkStorageHealth(table, '/data/media', true);
    expect(h.state).toBe('degraded');
    expect(h.device).toBe('overlay');
  });

  it('documents the pseudo-filesystem boundary', () => {
    // tmpfs reuses its device string across distinct instances, so the
    // root-device heuristic cannot distinguish them. This reports degraded.
    // On Fly this cannot false-positive a genuine volume: volumes are
    // /dev/vdX block devices, root is overlay — the strings never collide.
    // (A tmpfs /data/media would not be persistent anyway.)
    const table = 'tmpfs / tmpfs rw 0 0\ntmpfs /data/media tmpfs rw 0 0\n';
    const h = checkStorageHealth(table, '/data/media', true);
    expect(h.state).toBe('degraded');
  });

  it('does not flag a genuine block-device volume sharing no string with root', () => {
    const table = 'overlay / overlay rw 0 0\n/dev/vdb /data/media ext4 rw 0 0\n';
    const h = checkStorageHealth(table, '/data/media', true);
    expect(h.state).toBe('ok');
    expect(h.device).toBe('/dev/vdb');
  });

  it('reports degraded when the write probe failed', () => {
    const h = checkStorageHealth(healthyTable, '/data/media', false);
    expect(h.state).toBe('degraded');
    expect(h.device).toBe('/dev/vdb');
    expect(h.writable).toBe(false);
  });

  it('reports unknown when the mount table is unreadable', () => {
    const h = checkStorageHealth(null, '/data/media', true);
    expect(h).toEqual({
      state: 'unknown',
      mountpoint: '/data/media',
      device: null,
      writable: true,
    });
  });
});

describe('probeWritable', () => {
  it('returns true for a writable directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    try {
      expect(probeWritable(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a nonexistent directory without throwing', () => {
    expect(probeWritable('/nonexistent-dir-xyz-123')).toBe(false);
  });

  it('leaves no probe file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    try {
      probeWritable(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never truncates a pre-existing file, even at the legacy probe name', () => {
    // Regression: the old implementation used 'w' on `.write-probe-<pid>`,
    // which would truncate a colliding file. The probe must use exclusive
    // creation and never touch files it did not create.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const sentinel = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(sentinel, 'do-not-touch');
    try {
      for (let i = 0; i < 5; i++) {
        expect(probeWritable(dir)).toBe(true);
      }
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('do-not-touch');
      expect(fs.readdirSync(dir)).toEqual([path.basename(sentinel)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toTopLevelStatus', () => {
  it('passes states through explicitly', () => {
    expect(toTopLevelStatus('ok')).toBe('ok');
    expect(toTopLevelStatus('degraded')).toBe('degraded');
  });

  it('reports unknown as unknown, never masked as ok', () => {
    // Regression: the old ternary mapped everything non-degraded to 'ok',
    // misleading consumers when the mount table was unreadable.
    expect(toTopLevelStatus('unknown')).toBe('unknown');
  });
});

describe('readMountTable', () => {
  it('does not throw and returns string or null', () => {
    const result = readMountTable();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
