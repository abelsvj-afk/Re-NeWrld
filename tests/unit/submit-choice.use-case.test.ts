import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pkg from 'pg';
import { SubmitChoiceUseCase } from '../../src/modules/session/application/submit-choice.use-case.js';
import { SessionRepositoryPort } from '../../src/modules/session/domain/ports/session.repository.port.js';
import { CanonRepositoryPort } from '../../src/modules/world/domain/ports/canon.repository.port.js';
import {
  IdempotencyRepositoryPort,
  IdempotencyRecord,
} from '../../src/modules/session/domain/ports/idempotency.repository.port.js';
import { ReaderSession } from '../../src/modules/session/domain/entities/reader-session.entity.js';
import { SessionId } from '../../src/modules/session/domain/value-objects/session-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SnapshotId } from '../../src/modules/world/domain/value-objects/snapshot-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { CanonSnapshot } from '../../src/modules/world/domain/entities/canon-snapshot.entity.js';
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from '../../src/modules/session/domain/errors/session.errors.js';
import {
  ChoiceNotFoundError,
  ChoiceNotAttachedError,
  ChoiceNotAvailableError,
  SessionTerminalError,
  IdempotencyConflictError,
  CanonInvariantError,
  LegacyPayloadRejectedError,
  MutationApplicationError,
  StoredResponseCorruptError,
} from '../../src/modules/session/domain/errors/choice.errors.js';
import { computeRequestFingerprint } from '../../src/modules/session/domain/services/idempotency-fingerprint.js';

// Mock the transaction primitive: run fn with a dummy client, rethrow on error.
vi.mock('../../src/shared/database/db.js', () => ({
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  query: async () => {
    throw new Error('query not mocked');
  },
}));

// Deterministic fixtures.
const READER = '11111111-1111-4111-8111-111111111111';
const OTHER_READER = '99999999-9999-4999-8999-999999999999';
const WORLD = '22222222-2222-4222-8222-222222222222';
const SNAP = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4434-8444-444444444444';
const S2 = '55555555-5555-4535-8555-555555555555';
const SEND = '66666666-6666-4636-8666-666666666666';
const C1 = '77777777-7777-4737-8777-777777777777'; // S1 -> S2
const C2 = '88888888-8888-4838-8888-888888888888'; // S2 -> SEND (ending)
const C3 = '99999999-9999-4939-8999-999999999999'; // S1 -> S2 (conditional)
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const KEY = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';

function makeCanon(opts: {
  marker?: boolean;
  c1conditions?: unknown;
  c1mutations?: unknown;
  c3conditions?: unknown;
  s2choices?: unknown[];
} = {}): CanonSnapshot {
  const choices: any[] = [
    {
      choice_id: C1,
      scene_id: S1,
      target_scene_id: S2,
      text: 'Go to S2',
      sort_order: 0,
    },
    {
      choice_id: C2,
      scene_id: S2,
      target_scene_id: SEND,
      text: 'Finish',
      sort_order: 0,
    },
  ];
  if (opts.c1conditions !== undefined) choices[0].conditions = opts.c1conditions;
  if (opts.c1mutations !== undefined) choices[0].mutations = opts.c1mutations;
  if (opts.c3conditions !== undefined) {
    choices.push({
      choice_id: C3,
      scene_id: S1,
      target_scene_id: S2,
      text: 'Conditional',
      conditions: opts.c3conditions,
      sort_order: 1,
    });
  }
  if (opts.s2choices) {
    for (const c of opts.s2choices as any[]) choices.push(c);
  }
  const data: any = {
    canon_schema_version: 1,
    world: {
      world_id: WORLD,
      title: 'T',
      description: null,
      metadata: {},
      start_scene_id: S1,
    },
    scenes: [
      { scene_id: S1, chapter_id: WORLD, title: 'S1', prose: 'p', metadata: {}, is_ending: false },
      { scene_id: S2, chapter_id: WORLD, title: 'S2', prose: 'p', metadata: {}, is_ending: false },
      { scene_id: SEND, chapter_id: WORLD, title: 'End', prose: 'p', metadata: {}, is_ending: true },
    ],
    choices,
  };
  if (opts.marker !== false) data.condition_grammar_version = 1;
  return CanonSnapshot.create({
    snapshotId: new SnapshotId(SNAP),
    worldId: new WorldId(WORLD),
    versionNumber: 1,
    canonData: data,
  });
}

function makeSession(overrides: { status?: string; version?: number; scene?: string; state?: any } = {}): ReaderSession {
  return ReaderSession.create({
    sessionId: new SessionId(SESSION),
    readerId: new UserId(READER),
    worldId: new WorldId(WORLD),
    snapshotId: new SnapshotId(SNAP),
    currentSceneId: new SceneId(overrides.scene ?? S1),
    stateVariables: overrides.state ?? { gold: 10 },
    version: overrides.version ?? 1,
    status: undefined,
  });
}

class FakeSessionRepository implements SessionRepositoryPort {
  public store = new Map<string, ReaderSession>();
  public timeline: any[] = [];
  /** The real Postgres repo materializes a NEW entity per read; the fake must too. */
  private copy(s: ReaderSession): ReaderSession {
    const c = ReaderSession.create({
      sessionId: s.getSessionId(),
      readerId: s.getReaderId(),
      worldId: s.getWorldId(),
      snapshotId: s.getSnapshotId(),
      currentSceneId: s.getCurrentSceneId(),
      stateVariables: s.getStateVariables(),
      version: s.getVersion(),
    });
    // Mirror status (create defaults to active).
    const status = s.getStatus().getValue();
    if (status === 'completed') c.complete();
    else if (status === 'abandoned') c.abandon();
    return c;
  }
  async findById(id: SessionId) {
    const s = this.store.get(id.getValue());
    return s ? this.copy(s) : null;
  }
  async findByReaderId() {
    return [...this.store.values()];
  }
  async save(s: ReaderSession) {
    this.store.set(s.getSessionId().getValue(), s);
  }
  async findByIdForUpdate(id: SessionId, _tx: pkg.PoolClient) {
    return this.findById(id);
  }
  async persistChoiceResult(args: any, _tx: pkg.PoolClient) {
    this.store.set(args.session.getSessionId().getValue(), args.session);
    this.timeline.push({
      fromSceneId: args.fromSceneId.getValue(),
      toSceneId: args.session.getCurrentSceneId().getValue(),
      choiceId: args.choiceId.getValue(),
      state_diff: args.envelope,
    });
  }
}

class FakeCanonRepository implements CanonRepositoryPort {
  public snapshot: CanonSnapshot | null = null;
  async nextVersion() {
    return 1;
  }
  async insert(s: CanonSnapshot) {
    this.snapshot = s;
  }
  async findLatestByWorldId() {
    return this.snapshot;
  }
  async findById(id: SnapshotId) {
    return this.snapshot && this.snapshot.getSnapshotId().equals(id) ? this.snapshot : null;
  }
}

class FakeIdempotencyRepository implements IdempotencyRepositoryPort {
  public store = new Map<string, IdempotencyRecord & { expiresAt: Date }>();
  private toRecord(r: IdempotencyRecord & { expiresAt: Date }): IdempotencyRecord {
    return { ...r, isExpired: r.expiresAt <= new Date() };
  }
  async findUnexpiredByKey(key: string) {
    const r = this.store.get(key);
    if (!r || r.expiresAt <= new Date()) return null;
    return this.toRecord(r);
  }
  async findByKeyForUpdate(key: string, _tx: pkg.PoolClient) {
    const r = this.store.get(key);
    return r ? this.toRecord(r) : null;
  }
  public failInsertOnce = false;
  async insert(rec: any, _tx: pkg.PoolClient) {
    if (this.failInsertOnce) {
      this.failInsertOnce = false;
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    if (this.store.has(rec.idempotencyKey)) {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    this.store.set(rec.idempotencyKey, {
      idempotencyKey: rec.idempotencyKey,
      sessionId: rec.sessionId,
      requestHash: rec.requestHash,
      response: rec.response,
      expiresAt: rec.expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000),
      isExpired: false,
    });
  }
  async deleteByKey(key: string, _tx: pkg.PoolClient) {
    this.store.delete(key);
  }
  async deleteExpired() {
    let n = 0;
    for (const [k, r] of this.store) {
      if (r.expiresAt <= new Date()) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  }
}

function setup(canonOpts: Parameters<typeof makeCanon>[0] = {}) {
  const sessions = new FakeSessionRepository();
  const canon = new FakeCanonRepository();
  const idempotency = new FakeIdempotencyRepository();
  sessions.store.set(SESSION, makeSession());
  canon.snapshot = makeCanon(canonOpts);
  const useCase = new SubmitChoiceUseCase(sessions, canon, idempotency);
  const cmd = (overrides: any = {}) => ({
    sessionId: new SessionId(SESSION),
    readerId: new UserId(READER),
    choiceId: new ChoiceId(C1),
    expectedVersion: 1,
    idempotencyKey: KEY,
    ...overrides,
  });
  return { sessions, canon, idempotency, useCase, cmd };
}

describe('SubmitChoiceUseCase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: unconditional choice, exact response schema, timeline envelope', async () => {
    const { useCase, cmd, sessions } = setup({
      c1mutations: [{ op: 'inc', var: 'gold', by: 5 }],
    });
    const result = await useCase.execute(cmd());
    expect(result).toEqual({
      sessionId: SESSION,
      version: 2,
      currentSceneId: S2,
      status: 'active',
      appliedMutations: [{ op: 'inc', var: 'gold', value: 15 }],
      availableChoices: [{ choiceId: C2, text: 'Finish', sortOrder: 0 }],
    });
    // Timeline envelope (D1b).
    expect(sessions.timeline).toHaveLength(1);
    expect(sessions.timeline[0].state_diff).toEqual({
      kind: 'choice-execution-v1',
      applied: [{ op: 'inc', var: 'gold', value: 15 }],
    });
    // Session state replaced (not merged).
    const s = sessions.store.get(SESSION)!;
    expect(s.getStateVariables()).toEqual({ gold: 15 });
    expect(s.getVersion()).toBe(2);
  });

  it('404: unknown session and wrong-owner session', async () => {
    const { useCase, cmd } = setup();
    await expect(
      useCase.execute(cmd({ sessionId: new SessionId('aaaaaaaa-bbbb-4ccc-8ddd-000000000099') }))
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      useCase.execute(cmd({ readerId: new UserId(OTHER_READER) }))
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('404: unknown choice id', async () => {
    const { useCase, cmd } = setup();
    await expect(
      useCase.execute(
        cmd({ choiceId: new ChoiceId('aaaaaaaa-bbbb-4ccc-8ddd-000000000099') })
      )
    ).rejects.toBeInstanceOf(ChoiceNotFoundError);
  });

  it('422: choice not attached to current scene (placement, B30)', async () => {
    const { useCase, cmd } = setup();
    await expect(
      useCase.execute(cmd({ choiceId: new ChoiceId(C2) }))
    ).rejects.toBeInstanceOf(ChoiceNotAttachedError);
  });

  it('422: conditions false → zero writes', async () => {
    const { useCase, cmd, sessions, idempotency } = setup({
      c1conditions: { op: 'gte', var: 'gold', value: 999 },
    });
    await expect(useCase.execute(cmd())).rejects.toBeInstanceOf(ChoiceNotAvailableError);
    expect(sessions.timeline).toHaveLength(0);
    expect(idempotency.store.size).toBe(0);
    expect(sessions.store.get(SESSION)!.getVersion()).toBe(1);
  });

  it('422: invalid mutation (applicability) → zero writes, typed error', async () => {
    const { useCase, cmd, sessions } = setup({
      c1mutations: [{ op: 'inc', var: 'missing', by: 1 }],
    });
    await expect(useCase.execute(cmd())).rejects.toBeInstanceOf(MutationApplicationError);
    expect(sessions.timeline).toHaveLength(0);
  });

  it('409: terminal session (fast path)', async () => {
    const { sessions, useCase, cmd } = setup();
    const s = sessions.store.get(SESSION)!;
    s.complete();
    await expect(useCase.execute(cmd())).rejects.toBeInstanceOf(SessionTerminalError);
  });

  it('409: version mismatch carries currentVersion', async () => {
    const { useCase, cmd } = setup();
    const err = await useCase.execute(cmd({ expectedVersion: 99 })).catch((e) => e);
    expect(err).toBeInstanceOf(SessionVersionConflictError);
    expect(err.report.currentVersion).toBe(1);
  });

  it('409: stale version + failing condition → 409 (version precedence, not 422)', async () => {
    const { useCase, cmd } = setup({
      c1conditions: { op: 'gte', var: 'gold', value: 999 },
    });
    const err = await useCase.execute(cmd({ expectedVersion: 99 })).catch((e) => e);
    expect(err).toBeInstanceOf(SessionVersionConflictError);
  });

  it('ending target → completed, exactly one version increment, availableChoices []', async () => {
    const { sessions, useCase, cmd } = setup();
    // Move to S2 first.
    const r1 = await useCase.execute(cmd());
    expect(r1.currentSceneId).toBe(S2);
    const r2 = await useCase.execute(
      cmd({ choiceId: new ChoiceId(C2), expectedVersion: 2, idempotencyKey: 'cccccccc-dddd-4eee-8fff-000000000001' })
    );
    expect(r2.status).toBe('completed');
    expect(r2.version).toBe(3);
    expect(r2.currentSceneId).toBe(SEND);
    expect(r2.availableChoices).toEqual([]);
    const s = sessions.store.get(SESSION)!;
    expect(s.getStatus().getValue()).toBe('completed');
    expect(s.getVersion()).toBe(3);
  });

  it('idempotent retry replays the stored response without re-execution', async () => {
    const { useCase, cmd, sessions, idempotency } = setup({
      c1mutations: [{ op: 'inc', var: 'gold', by: 5 }],
    });
    const first = await useCase.execute(cmd());
    const second = await useCase.execute(cmd());
    expect(second).toEqual(first);
    // Single timeline row, single version increment.
    expect(sessions.timeline).toHaveLength(1);
    expect(sessions.store.get(SESSION)!.getVersion()).toBe(2);
    expect(idempotency.store.size).toBe(1);
  });

  it('409: same key, different fingerprint', async () => {
    const { useCase, cmd } = setup();
    await useCase.execute(cmd());
    await expect(
      useCase.execute(cmd({ expectedVersion: 2 }))
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('409: same key, different session', async () => {
    const { sessions, useCase, cmd, canon } = setup();
    await useCase.execute(cmd());
    // Second session, same key.
    const s2id = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
    const s2 = ReaderSession.create({
      sessionId: new SessionId(s2id),
      readerId: new UserId(READER),
      worldId: new WorldId(WORLD),
      snapshotId: new SnapshotId(SNAP),
      currentSceneId: new SceneId(S1),
      stateVariables: {},
      version: 1,
    });
    sessions.store.set(s2id, s2);
    await expect(
      useCase.execute({
        sessionId: new SessionId(s2id),
        readerId: new UserId(READER),
        choiceId: new ChoiceId(C1),
        expectedVersion: 1,
        idempotencyKey: KEY,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    void canon;
  });

  it('retry after completion replays the stored success (never 409-terminal)', async () => {
    const { useCase, cmd } = setup();
    await useCase.execute(cmd());
    const r2 = await useCase.execute(
      cmd({ choiceId: new ChoiceId(C2), expectedVersion: 2, idempotencyKey: 'cccccccc-dddd-4eee-8fff-000000000001' })
    );
    expect(r2.status).toBe('completed');
    // Same key retry after completion → replay, not terminal-409.
    const replay = await useCase.execute(
      cmd({ choiceId: new ChoiceId(C2), expectedVersion: 2, idempotencyKey: 'cccccccc-dddd-4eee-8fff-000000000001' })
    );
    expect(replay).toEqual(r2);
  });

  it('expired record treated as miss (re-executed)', async () => {
    const { useCase, cmd, idempotency, sessions } = setup({
      c1mutations: [{ op: 'inc', var: 'gold', by: 5 }],
    });
    // Seed an expired record for the same key+fingerprint.
    const fp = computeRequestFingerprint(C1, 1, SESSION, READER);
    idempotency.store.set(KEY, {
      idempotencyKey: KEY,
      sessionId: SESSION,
      requestHash: fp,
      response: { stale: true },
      expiresAt: new Date(Date.now() - 1000),
      isExpired: true,
    });
    const result = await useCase.execute(cmd());
    expect(result.version).toBe(2);
    expect(result.appliedMutations).toEqual([{ op: 'inc', var: 'gold', value: 15 }]);
    expect(sessions.timeline).toHaveLength(1);
  });

  it('legacy {} condition executes as unconditional (marker absent)', async () => {
    const { useCase, cmd } = setup({
      marker: false,
      c1conditions: {},
      c1mutations: [{ op: 'inc', var: 'gold', by: 1 }],
    });
    const result = await useCase.execute(cmd());
    expect(result.version).toBe(2);
    expect(result.currentSceneId).toBe(S2);
  });

  it('legacy unparsable condition → 422 fail-closed, session functional', async () => {
    const { useCase, cmd, sessions } = setup({
      marker: false,
      c1conditions: { op: 'bogus', var: 'x' },
    });
    await expect(useCase.execute(cmd())).rejects.toBeInstanceOf(ChoiceNotAvailableError);
    expect(sessions.store.get(SESSION)!.getVersion()).toBe(1);
  });

  it('marked unparsable condition → 500 CanonInvariantError, zero writes', async () => {
    const { useCase, cmd, sessions, idempotency } = setup({
      c1conditions: { op: 'bogus', var: 'x' },
    });
    const err = await useCase.execute(cmd()).catch((e) => e);
    expect(err).toBeInstanceOf(CanonInvariantError);
    expect(err.statusCode).toBe(500);
    expect(sessions.timeline).toHaveLength(0);
    expect(idempotency.store.size).toBe(0);
  });

  it('marked unparsable mutations → 500; legacy → 422', async () => {
    const marked = setup({ c1mutations: [{ op: 'bogus', var: 'x' }] as any });
    const errMarked = await marked.useCase.execute(marked.cmd()).catch((e) => e);
    expect(errMarked).toBeInstanceOf(CanonInvariantError);

    const legacy = setup({ marker: false, c1mutations: [{ op: 'bogus', var: 'x' }] as any });
    const errLegacy = await legacy.useCase.execute(legacy.cmd()).catch((e) => e);
    expect(errLegacy).toBeInstanceOf(LegacyPayloadRejectedError);
    expect(errLegacy.statusCode).toBe(422);
  });

  it('B33: malformed sibling in marked target scene → 500, zero writes', async () => {
    const { useCase, cmd, sessions, idempotency } = setup({
      s2choices: [
        {
          choice_id: 'dddddddd-eeee-4fff-8000-000000000001',
          scene_id: S2,
          target_scene_id: SEND,
          text: 'Broken sibling',
          conditions: { op: 'nope' },
          sort_order: 1,
        },
      ],
    });
    const err = await useCase.execute(cmd()).catch((e) => e);
    expect(err).toBeInstanceOf(CanonInvariantError);
    expect(sessions.timeline).toHaveLength(0);
    expect(idempotency.store.size).toBe(0);
    expect(sessions.store.get(SESSION)!.getVersion()).toBe(1);
  });

  it('legacy malformed sibling in target scene → excluded, submission succeeds', async () => {
    const { useCase, cmd } = setup({
      marker: false,
      s2choices: [
        {
          choice_id: 'dddddddd-eeee-4fff-8000-000000000001',
          scene_id: S2,
          target_scene_id: SEND,
          text: 'Broken sibling',
          conditions: { op: 'nope' },
          sort_order: 1,
        },
      ],
    });
    const result = await useCase.execute(cmd());
    expect(result.version).toBe(2);
    // Only the valid C2 is listed.
    expect(result.availableChoices).toEqual([{ choiceId: C2, text: 'Finish', sortOrder: 0 }]);
  });

  it('D3a: unique violation → recovery replays the winner', async () => {
    const { useCase, cmd, idempotency } = setup({
      c1mutations: [{ op: 'inc', var: 'gold', by: 5 }],
    });
    // Simulate the race faithfully: the store is EMPTY for the early lookup
    // (step 3) and the in-tx recheck (step 8), so execution proceeds to the
    // insert (step 16). The insert then throws 23505 — and as a side effect,
    // the concurrent winner's record appears in the store (it committed
    // first). Recovery must re-read AFTER the rollback and replay the winner.
    // (Previous version of this test pre-populated the store, which made
    // step 3 hit and never exercised the recovery path at all.)
    const fp = computeRequestFingerprint(C1, 1, SESSION, READER);
    const winnerResponse = {
      sessionId: SESSION,
      version: 2,
      currentSceneId: S2,
      status: 'active',
      appliedMutations: [{ op: 'inc', var: 'gold', value: 15 }],
      availableChoices: [{ choiceId: C2, text: 'Finish', sortOrder: 0 }],
    };
    const winnerRecord = {
      idempotencyKey: KEY,
      sessionId: SESSION,
      requestHash: fp,
      response: winnerResponse,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      isExpired: false,
    };
    // Override insert: throw 23505 AND plant the winner's record, simulating
    // the concurrent transaction that committed first.
    const originalInsert = idempotency.insert.bind(idempotency);
    idempotency.insert = async (rec: any, tx: pkg.PoolClient) => {
      idempotency.store.set(KEY, winnerRecord);
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    };
    const result = await useCase.execute(cmd());
    expect(result).toEqual(winnerResponse);
    // Restore for other tests (the setup() creates a fresh fake per test,
    // but be explicit since we mutated the instance).
    idempotency.insert = originalInsert;
  });

  it('B38: corrupt stored response → 500 StoredResponseCorruptError, never served', async () => {
    const { useCase, cmd, idempotency } = setup();
    const fp = computeRequestFingerprint(C1, 1, SESSION, READER);
    idempotency.store.set(KEY, {
      idempotencyKey: KEY,
      sessionId: SESSION,
      requestHash: fp,
      response: { garbage: true },
      expiresAt: new Date(Date.now() + 3600 * 1000),
      isExpired: false,
    });
    const err = await useCase.execute(cmd()).catch((e) => e);
    expect(err).toBeInstanceOf(StoredResponseCorruptError);
    expect(err.statusCode).toBe(500);
  });

  it('unset deletion semantics in appliedMutations', async () => {
    const { useCase, cmd } = setup({
      c1mutations: [
        { op: 'unset', var: 'gold' },
        { op: 'unset', var: 'absent' },
      ],
    });
    const result = await useCase.execute(cmd());
    expect(result.appliedMutations).toEqual([
      { op: 'unset', var: 'gold', removed: true },
      { op: 'unset', var: 'absent', removed: false },
    ]);
    expect(result.version).toBe(2);
  });

  it('availableChoices evaluates target-scene conditions against the NEW state', async () => {
    const { useCase, cmd } = setup({
      c1mutations: [{ op: 'set', var: 'gold', value: 3 }],
      s2choices: [
        {
          choice_id: 'dddddddd-eeee-4fff-8000-000000000001',
          scene_id: S2,
          target_scene_id: SEND,
          text: 'Rich exit',
          conditions: { op: 'gte', var: 'gold', value: 10 },
          sort_order: 0,
        },
      ],
    });
    // After C1, gold=3 → the conditional S2 choice is excluded; C2 (unconditional) listed.
    const result = await useCase.execute(cmd());
    expect(result.availableChoices).toEqual([{ choiceId: C2, text: 'Finish', sortOrder: 0 }]);
  });

  it('availableChoices includes a choice whose condition becomes true', async () => {
    const { useCase, cmd } = setup({
      c1mutations: [{ op: 'set', var: 'gold', value: 20 }],
      s2choices: [
        {
          choice_id: 'dddddddd-eeee-4fff-8000-000000000001',
          scene_id: S2,
          target_scene_id: SEND,
          text: 'Rich exit',
          conditions: { op: 'gte', var: 'gold', value: 10 },
          sort_order: 0,
        },
      ],
    });
    const result = await useCase.execute(cmd());
    expect(result.availableChoices).toEqual([
      { choiceId: C2, text: 'Finish', sortOrder: 0 },
      { choiceId: 'dddddddd-eeee-4fff-8000-000000000001', text: 'Rich exit', sortOrder: 0 },
    ]);
  });
});
