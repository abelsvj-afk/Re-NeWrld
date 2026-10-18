import { WorldId } from '../value-objects/world-id.value-object.js';

/** Reservation states per migration 015. Active = RESERVED or WRITING. */
export type StorageReservationState =
  | 'RESERVED'
  | 'WRITING'
  | 'ABANDONED'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'CLEANED';

export interface StorageReservation {
  reservationId: string;
  worldId: WorldId;
  sizeBytes: number;
  state: StorageReservationState;
  epoch: number;
  createdAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
}

export interface CreateReservationInput {
  worldId: WorldId;
  sizeBytes: number;
}

/**
 * Repository port for durable storage reservations (ADR-017 §5.5, RES-1a).
 * The reservation row is the concurrency-safe capacity accounting primitive:
 * committed rows are visible to concurrent Phase-1 transactions under
 * READ COMMITTED, so the capacity check cannot be bypassed by racing.
 */
export interface StorageReservationRepositoryPort {
  /**
   * Insert a RESERVED reservation row. The caller must already hold the
   * Phase-1 locks; this method performs only the INSERT.
   */
  create(input: CreateReservationInput, tx: unknown): Promise<StorageReservation>;

  /**
   * Sum of size_bytes for active reservations (state RESERVED or WRITING,
   * equivalently released_at IS NULL). Optionally scoped to one world.
   */
  sumActiveBytes(worldId?: WorldId, tx?: unknown): Promise<number>;

  findById(reservationId: string, tx?: unknown): Promise<StorageReservation | null>;
}
