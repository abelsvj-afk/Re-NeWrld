import type pkg from 'pg';
import {
  SessionRepositoryPort,
  PersistChoiceResultArgs,
} from '../../domain/ports/session.repository.port.js';
import { ReaderSession, SessionState } from '../../domain/entities/reader-session.entity.js';
import { SessionId } from '../../domain/value-objects/session-id.value-object.js';
import { SessionStatus } from '../../domain/value-objects/session-status.value-object.js';
import { WorldId } from '../../../world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../../world/domain/value-objects/scene-id.value-object.js';
import { SnapshotId } from '../../../world/domain/value-objects/snapshot-id.value-object.js';
import { ChoiceId } from '../../../world/domain/value-objects/choice-id.value-object.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from '../../domain/errors/session.errors.js';
import { query, withTransaction } from '../../../../shared/database/db.js';

interface SessionRow {
  session_id: string;
  reader_id: string;
  world_id: string;
  snapshot_id: string;
  current_scene_id: string;
  state_variables: unknown;
  version: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface ApplyTransitionArgs {
  sessionId: SessionId;
  expectedVersion: number;
  toSceneId: SceneId;
  stateDiff: SessionState;
  /** Required by reader_timelines; supplied by Phase G's choice resolver. */
  choiceId: ChoiceId;
}

/**
 * Postgres adapter for reader sessions (Task F2a).
 *
 * `applyTransition` is the atomic persistence mechanism for choice
 * application (resolution logic itself is Phase G): it locks the session row,
 * checks the optimistic version, delegates the transition to the
 * `ReaderSession` entity (never bypassed, never duplicated), then persists
 * the session update and the timeline append in one transaction.
 *
 * Transaction ownership: when the caller supplies `tx`, this repository
 * issues statements only — it never BEGINs, COMMITs, or ROLLBACKs. When no
 * `tx` is supplied, the work is wrapped in the existing `withTransaction`
 * helper. No parallel transaction abstraction.
 */
export class PostgresSessionRepository implements SessionRepositoryPort {
  public async findById(sessionId: SessionId): Promise<ReaderSession | null> {
    const result = await query<SessionRow>(
      `SELECT session_id, reader_id, world_id, snapshot_id, current_scene_id,
              state_variables, version, status, created_at, updated_at
       FROM reader_sessions WHERE session_id = $1`,
      [sessionId.getValue()]
    );
    if (result.rowCount === 0) {
      return null;
    }
    return this.mapRowToSession(result.rows[0]);
  }

  public async findByReaderId(readerId: UserId): Promise<ReaderSession[]> {
    const result = await query<SessionRow>(
      `SELECT session_id, reader_id, world_id, snapshot_id, current_scene_id,
              state_variables, version, status, created_at, updated_at
       FROM reader_sessions WHERE reader_id = $1`,
      [readerId.getValue()]
    );
    return result.rows.map((row) => this.mapRowToSession(row));
  }

  public async save(session: ReaderSession, tx?: pkg.PoolClient): Promise<void> {
    const sql = `INSERT INTO reader_sessions
       (session_id, reader_id, world_id, snapshot_id, current_scene_id,
        state_variables, version, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       ON CONFLICT (session_id) DO UPDATE SET
         current_scene_id = EXCLUDED.current_scene_id,
         state_variables = EXCLUDED.state_variables,
         version = EXCLUDED.version,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`;
    const params = [
      session.getSessionId().getValue(),
      session.getReaderId().getValue(),
      session.getWorldId().getValue(),
      session.getSnapshotId().getValue(),
      session.getCurrentSceneId().getValue(),
      JSON.stringify(session.getStateVariables()),
      session.getVersion(),
      session.getStatus().getValue(),
      session.getCreatedAt(),
      session.getUpdatedAt(),
    ];
    if (tx) {
      await tx.query(sql, params);
    } else {
      await query(sql, params);
    }
  }

  /**
   * Atomically applies one state transition (ADR-014 D4, §9.2, §10.3–§10.4).
   *
   * Single transaction, single client: SELECT ... FOR UPDATE → version check
   * → entity transition → session UPDATE → timeline INSERT. A version
   * mismatch throws `SessionVersionConflictError` (409) with zero writes; any
   * entity validation or insert failure rolls back the whole transaction.
   *
   * Sequence numbers are allocated as MAX(sequence_number)+1 inside the
   * transaction while holding the session row lock — "gapless" means no
   * missing values among committed entries (not PG nextval semantics). The
   * UNIQUE(session_id, sequence_number) constraint is the backstop.
   */
  public async applyTransition(
    args: ApplyTransitionArgs,
    tx?: pkg.PoolClient
  ): Promise<ReaderSession> {
    if (tx) {
      return this.applyTransitionTx(args, tx);
    }
    return withTransaction((client) => this.applyTransitionTx(args, client));
  }

  private async applyTransitionTx(
    args: ApplyTransitionArgs,
    tx: pkg.PoolClient
  ): Promise<ReaderSession> {
    const selectResult = await tx.query<SessionRow>(
      `SELECT session_id, reader_id, world_id, snapshot_id, current_scene_id,
              state_variables, version, status, created_at, updated_at
       FROM reader_sessions WHERE session_id = $1 FOR UPDATE`,
      [args.sessionId.getValue()]
    );
    if (selectResult.rowCount === 0) {
      throw new SessionNotFoundError();
    }
    const row = selectResult.rows[0];
    const currentVersion = Number(row.version);
    if (currentVersion !== args.expectedVersion) {
      throw new SessionVersionConflictError(currentVersion);
    }

    const session = this.mapRowToSession(row);
    const fromSceneId = session.getCurrentSceneId();
    // Domain transition rules enforced here — active-only, version bump.
    session.applyTransition(args.toSceneId, args.stateDiff);

    await tx.query(
      `UPDATE reader_sessions
       SET current_scene_id = $1, state_variables = $2::jsonb, version = $3, updated_at = $4
       WHERE session_id = $5`,
      [
        session.getCurrentSceneId().getValue(),
        JSON.stringify(session.getStateVariables()),
        session.getVersion(),
        session.getUpdatedAt(),
        args.sessionId.getValue(),
      ]
    );

    const seqResult = await tx.query(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
       FROM reader_timelines WHERE session_id = $1`,
      [args.sessionId.getValue()]
    );
    const nextSeq = Number(seqResult.rows[0].next_seq);
    await tx.query(
      `INSERT INTO reader_timelines
         (session_id, sequence_number, from_scene_id, to_scene_id, choice_id, state_diff)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        args.sessionId.getValue(),
        nextSeq,
        fromSceneId.getValue(),
        args.toSceneId.getValue(),
        args.choiceId.getValue(),
        JSON.stringify(args.stateDiff),
      ]
    );

    return session;
  }

  public async findByIdForUpdate(
    sessionId: SessionId,
    tx: pkg.PoolClient
  ): Promise<ReaderSession | null> {
    const result = await tx.query<SessionRow>(
      `SELECT session_id, reader_id, world_id, snapshot_id, current_scene_id,
              state_variables, version, status, created_at, updated_at
       FROM reader_sessions WHERE session_id = $1 FOR UPDATE`,
      [sessionId.getValue()]
    );
    if (result.rowCount === 0) {
      return null;
    }
    return this.mapRowToSession(result.rows[0]);
  }

  public async persistChoiceResult(
    args: PersistChoiceResultArgs,
    tx: pkg.PoolClient
  ): Promise<void> {
    const session = args.session;
    // UPDATE includes status (F2a's UPDATE omits it; G2 needs it for
    // ending targets — ADR-015 D3 step 16).
    await tx.query(
      `UPDATE reader_sessions
       SET current_scene_id = $1, state_variables = $2::jsonb, version = $3,
           status = $4, updated_at = $5
       WHERE session_id = $6`,
      [
        session.getCurrentSceneId().getValue(),
        JSON.stringify(session.getStateVariables()),
        session.getVersion(),
        session.getStatus().getValue(),
        session.getUpdatedAt(),
        session.getSessionId().getValue(),
      ]
    );

    const seqResult = await tx.query(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
       FROM reader_timelines WHERE session_id = $1`,
      [session.getSessionId().getValue()]
    );
    const nextSeq = Number(seqResult.rows[0].next_seq);
    // state_diff is the discriminated envelope, NOT the bare object diff
    // (ADR-015 D1b). Gapless MAX+1 under the row lock.
    await tx.query(
      `INSERT INTO reader_timelines
         (session_id, sequence_number, from_scene_id, to_scene_id, choice_id, state_diff)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        session.getSessionId().getValue(),
        nextSeq,
        args.fromSceneId.getValue(),
        session.getCurrentSceneId().getValue(),
        args.choiceId.getValue(),
        JSON.stringify(args.envelope),
      ]
    );
  }

  private mapRowToSession(row: SessionRow): ReaderSession {
    return ReaderSession.create({
      sessionId: new SessionId(row.session_id),
      readerId: new UserId(row.reader_id),
      worldId: new WorldId(row.world_id),
      snapshotId: new SnapshotId(row.snapshot_id),
      currentSceneId: new SceneId(row.current_scene_id),
      stateVariables: (row.state_variables as SessionState) ?? {},
      version: Number(row.version),
      status: new SessionStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
