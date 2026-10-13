import crypto from 'node:crypto';

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (err, derived) => {
      if (err) {
        reject(err);
      } else {
        resolve(derived);
      }
    });
  });
}

// scrypt parameters: ~100ms per hash on commodity hardware, 16MB memory.
// Format: scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

export class PasswordService {
  /**
   * Hashes a plaintext password with a random salt using scrypt.
   * Throws on passwords outside the 8-128 character policy.
   */
  public async hashPassword(password: string): Promise<string> {
    this.assertPasswordPolicy(password);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(password, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return [
      'scrypt',
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString('hex'),
      derived.toString('hex'),
    ].join('$');
  }

  /**
   * Verifies a plaintext password against a stored hash.
   * Returns false (never throws) for malformed stored hashes or policy-violating input,
   * so callers can treat "false" uniformly as invalid credentials.
   */
  public async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!password || typeof password !== 'string' || !storedHash || typeof storedHash !== 'string') {
      return false;
    }
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false;
    }
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) {
      return false;
    }
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[4], 'hex');
      expected = Buffer.from(parts[5], 'hex');
    } catch {
      return false;
    }
    if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
      return false;
    }
    let derived: Buffer;
    try {
      derived = await scryptAsync(password, salt, KEY_LENGTH, { N: n, r, p });
    } catch {
      return false;
    }
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }

  private assertPasswordPolicy(password: string): void {
    if (!password || typeof password !== 'string') {
      throw new Error('Password is required');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`Password must not exceed ${MAX_PASSWORD_LENGTH} characters`);
    }
  }
}
