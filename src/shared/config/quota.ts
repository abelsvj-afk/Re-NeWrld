/**
 * QUOTA-1: Quota configuration (ADR-017 §5.1, design rev 8)
 *
 * Per-world quota and per-file limits. Validated once at startup (fail-closed).
 */

/** Owner-confirmed default: 50 MB per world (2026-10-18). */
export const DEFAULT_QUOTA_MB = 50;

/** Maximum file size: 10 MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Upper bound for MEDIA_WORLD_QUOTA_MB: 1,000,000 MB (~1 TB).
 * Prevents safe-integer overflow when converting to bytes.
 */
const MAX_QUOTA_MB = 1_000_000;

export class QuotaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaConfigError';
  }
}

/**
 * Returns the per-world quota in bytes.
 *
 * Strict validation (rev 3):
 * - Unset → default (50 MB).
 * - Empty string → error (explicit misconfiguration).
 * - Must match /^[0-9]+$/ (no whitespace, no decimals, no trailing garbage).
 * - Must be > 0 and <= 1,000,000.
 * - Result must be a safe integer.
 */
export function getWorldQuotaBytes(): number {
  const raw = process.env.MEDIA_WORLD_QUOTA_MB;
  if (raw === undefined) return DEFAULT_QUOTA_MB * 1024 * 1024;
  if (!/^[0-9]+$/.test(raw)) {
    throw new QuotaConfigError(
      `Invalid MEDIA_WORLD_QUOTA_MB: "${raw}" (must be a positive whole number with no whitespace, e.g. "50")`
    );
  }
  const mb = Number(raw);
  if (mb <= 0) {
    throw new QuotaConfigError(`Invalid MEDIA_WORLD_QUOTA_MB: "${raw}" (must be > 0)`);
  }
  if (mb > MAX_QUOTA_MB) {
    throw new QuotaConfigError(
      `Invalid MEDIA_WORLD_QUOTA_MB: "${raw}" (exceeds maximum ${MAX_QUOTA_MB} MB)`
    );
  }
  const bytes = mb * 1024 * 1024;
  if (!Number.isSafeInteger(bytes)) {
    throw new QuotaConfigError(`MEDIA_WORLD_QUOTA_MB "${raw}" produces unsafe byte value`);
  }
  return bytes;
}

export class QuotaError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Enforces the 10 MB per-file limit. Called before reserveStorage().
 * Throws QuotaError with 413 if exceeded.
 */
export function checkFileSizeLimit(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new QuotaError(
      'FILE_TOO_LARGE',
      `File size ${sizeBytes} exceeds 10 MB limit.`,
      413
    );
  }
}

/**
 * Required (table, column) pairs for QUOTA-1 startup verification.
 * All eight must exist in the application's schema.
 */
export const REQUIRED_QUOTA_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'world_media_assets', column: 'lifecycle' },
  { table: 'world_media_assets', column: 'file_confirmed_present' },
  { table: 'world_media_assets', column: 'size_bytes' },
  { table: 'world_media_assets', column: 'publication_status' },
  { table: 'world_media_assets', column: 'reservation_id' },
  { table: 'world_media_assets', column: 'content_sha256' },
  { table: 'storage_reservations', column: 'state' },
  { table: 'storage_reservations', column: 'size_bytes' },
];

/**
 * Verifies all required quota columns exist. Throws QuotaConfigError
 * with QUOTA_SCHEMA_INCOMPLETE naming the missing pair if any are absent.
 */
export async function verifyQuotaSchema(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
): Promise<void> {
  const result = await query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND (
         (table_name = 'world_media_assets'
          AND column_name IN ('lifecycle', 'file_confirmed_present', 'size_bytes',
                              'publication_status', 'reservation_id', 'content_sha256'))
         OR
         (table_name = 'storage_reservations'
          AND column_name IN ('state', 'size_bytes'))
       )`
  );
  const found = new Set(result.rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = REQUIRED_QUOTA_COLUMNS.filter(
    ({ table, column }) => !found.has(`${table}.${column}`)
  );
  if (missing.length > 0) {
    const names = missing.map(({ table, column }) => `${table}.${column}`).join(', ');
    throw new QuotaConfigError(`QUOTA_SCHEMA_INCOMPLETE: missing ${names}`);
  }
}
