import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { ReaderSession } from '../../src/modules/session/domain/entities/reader-session.entity.js';
import { SessionId } from '../../src/modules/session/domain/value-objects/session-id.value-object.js';
import { SessionStatus } from '../../src/modules/session/domain/value-objects/session-status.value-object.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { SnapshotId } from '../../src/modules/world/domain/value-objects/snapshot-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import {
  SessionValidationError,
  IllegalSessionTransitionError,
} from '../../src/modules/session/domain/errors/session.errors.js';

function makeSession(overrides: Partial<Parameters<typeof ReaderSession.create>[0]> = {}) {
  return ReaderSession.create({
    sessionId: new SessionId(crypto.randomUUID()),
    readerId: new UserId(crypto.randomUUID()),
    worldId: new WorldId(crypto.randomUUID()),
    snapshotId: new SnapshotId(crypto.randomUUID()),
    currentSceneId: new SceneId(crypto.randomUUID()),
    ...overrides,
  });
}

describe('ReaderSession entity (F1a)', () => {
  it('creates an active session at version 1 with empty state by default', () => {
    const session = makeSession();
    expect(session.getStatus().getValue()).toBe('active');
    expect(session.getVersion()).toBe(1);
    expect(session.getStateVariables()).toEqual({});
    expect(session.getCreatedAt()).toBeInstanceOf(Date);
  });

  it('rejects non-JSON-serializable state and invalid versions', () => {
    expect(() => makeSession({ stateVariables: { fn: (() => {}) as unknown as string } })).toThrow(
      SessionValidationError
    );
    expect(() => makeSession({ stateVariables: { nan: NaN } })).toThrow(SessionValidationError);
    expect(() => makeSession({ version: 0 })).toThrow(SessionValidationError);
    expect(() => makeSession({ version: 1.5 })).toThrow(SessionValidationError);
    expect(() => makeSession({ status: new SessionStatus('bogus' as never) })).toThrow();
  });

  it('accepts nested JSON state', () => {
    const session = makeSession({
      stateVariables: { gold: 10, flags: { met_guide: true }, path: ['a', 'b'], nothing: null },
    });
    expect(session.getStateVariables()).toEqual({
      gold: 10,
      flags: { met_guide: true },
      path: ['a', 'b'],
      nothing: null,
    });
  });

  it('applyTransition moves scenes, merges state, and bumps the version', () => {
    const session = makeSession({ stateVariables: { gold: 10, hp: 100 } });
    const next = new SceneId(crypto.randomUUID());
    session.applyTransition(next, { gold: 5 });

    expect(session.getCurrentSceneId().equals(next)).toBe(true);
    expect(session.getStateVariables()).toEqual({ gold: 5, hp: 100 });
    expect(session.getVersion()).toBe(2);
  });

  it('version increments only via applyTransition', () => {
    const session = makeSession();
    const scene = new SceneId(crypto.randomUUID());
    session.applyTransition(scene, {});
    session.applyTransition(scene, {});
    expect(session.getVersion()).toBe(3);
    // No other public mutator touches the version.
    expect(session.getStatus().getValue()).toBe('active');
  });

  it('complete() moves active → completed; further transitions fail', () => {
    const session = makeSession();
    session.complete();
    expect(session.getStatus().getValue()).toBe('completed');

    expect(() => session.complete()).toThrow(IllegalSessionTransitionError);
    expect(() => session.abandon()).toThrow(IllegalSessionTransitionError);
    expect(() => session.applyTransition(new SceneId(crypto.randomUUID()), {})).toThrow(
      IllegalSessionTransitionError
    );
  });

  it('abandon() moves active → abandoned; terminal states never return to active', () => {
    const session = makeSession();
    session.abandon();
    expect(session.getStatus().getValue()).toBe('abandoned');

    expect(() => session.complete()).toThrow(IllegalSessionTransitionError);
    expect(() => session.abandon()).toThrow(IllegalSessionTransitionError);
    expect(() => session.applyTransition(new SceneId(crypto.randomUUID()), {})).toThrow(
      IllegalSessionTransitionError
    );
    // Terminal sessions stay terminal.
    expect(session.getStatus().getValue()).toBe('abandoned');
  });

  it('terminal sessions remain readable', () => {
    const session = makeSession({ stateVariables: { gold: 7 } });
    session.complete();
    expect(session.getSessionId()).toBeInstanceOf(SessionId);
    expect(session.getStateVariables()).toEqual({ gold: 7 });
    expect(session.getVersion()).toBe(1);
    expect(session.getCurrentSceneId()).toBeInstanceOf(SceneId);
  });

  it('getters return defensive copies', () => {
    const session = makeSession({ stateVariables: { nested: { x: 1 } } });
    const state = session.getStateVariables();
    (state.nested as Record<string, unknown>).x = 999;
    expect(session.getStateVariables()).toEqual({ nested: { x: 1 } });

    const created = session.getCreatedAt();
    created.setFullYear(2000);
    expect(session.getCreatedAt().getFullYear()).not.toBe(2000);
  });

  it('equals compares by session id', () => {
    const id = new SessionId(crypto.randomUUID());
    const a = makeSession({ sessionId: id });
    const b = makeSession({ sessionId: id });
    const c = makeSession();
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals(null)).toBe(false);
  });
});
