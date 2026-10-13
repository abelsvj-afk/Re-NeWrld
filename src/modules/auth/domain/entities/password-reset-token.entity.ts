import crypto from 'node:crypto';
import { UserId } from '../value-objects/user-id.value-object.js';

export interface PasswordResetTokenProps {
  tokenHash: string;
  userId: UserId;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * A single-use, time-limited password reset token. Only the SHA-256 hash is
 * ever persisted (mirrors the auth_sessions pattern from ADR-004); the raw
 * token is handed to the user once via email and then forgotten.
 */
export class PasswordResetToken {
  /** Token lifetime: 15 minutes (ADR-012). */
  public static readonly TTL_MS = 15 * 60 * 1000;
  /** Raw token size: 256 bits, base64url-encoded. */
  private static readonly TOKEN_BYTES = 32;

  private readonly tokenHash: string;
  private readonly userId: UserId;
  private readonly expiresAt: Date;
  private usedAt: Date | null;
  private readonly createdAt: Date;

  private constructor(props: PasswordResetTokenProps) {
    if (!SHA256_HEX_REGEX.test(props.tokenHash)) {
      throw new Error('PasswordResetToken tokenHash must be a SHA-256 hex string');
    }
    this.tokenHash = props.tokenHash;
    this.userId = props.userId;
    this.expiresAt = props.expiresAt;
    this.usedAt = props.usedAt;
    this.createdAt = props.createdAt;
  }

  /**
   * Issues a new token for the user. Returns the raw token (to email once)
   * alongside the persistable entity (which only carries the hash).
   */
  public static issue(userId: UserId, now: Date = new Date()): { rawToken: string; token: PasswordResetToken } {
    const rawToken = crypto.randomBytes(PasswordResetToken.TOKEN_BYTES).toString('base64url');
    const tokenHash = PasswordResetToken.hashRawToken(rawToken);
    const token = new PasswordResetToken({
      tokenHash,
      userId,
      expiresAt: new Date(now.getTime() + PasswordResetToken.TTL_MS),
      usedAt: null,
      createdAt: now,
    });
    return { rawToken, token };
  }

  public static hashRawToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /** Rehydrates a token from persistence. */
  public static rehydrate(props: PasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken(props);
  }

  public getTokenHash(): string {
    return this.tokenHash;
  }

  public getUserId(): UserId {
    return this.userId;
  }

  public getExpiresAt(): Date {
    return this.expiresAt;
  }

  public isUsed(): boolean {
    return this.usedAt !== null;
  }

  public isExpired(now: Date = new Date()): boolean {
    return this.expiresAt.getTime() <= now.getTime();
  }

  /** A token is consumable only when unused and unexpired. */
  public isConsumable(now: Date = new Date()): boolean {
    return !this.isUsed() && !this.isExpired(now);
  }

  public markUsed(now: Date = new Date()): void {
    if (this.isUsed()) {
      throw new Error('Password reset token has already been used');
    }
    this.usedAt = now;
  }

  public getUsedAt(): Date | null {
    return this.usedAt;
  }

  public getCreatedAt(): Date {
    return this.createdAt;
  }
}
