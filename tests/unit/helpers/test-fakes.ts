import crypto from 'node:crypto';
import { AuthRepositoryPort } from '../../../src/modules/auth/domain/ports/auth.repository.port.js';
import {
  SessionInfo,
  SessionServicePort,
  SessionVerifier,
} from '../../../src/modules/auth/domain/ports/session.port.js';
import { User } from '../../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../../src/modules/auth/domain/value-objects/email.value-object.js';
import { WorldRepositoryPort } from '../../../src/modules/world/domain/ports/world.repository.port.js';
import { World } from '../../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../../src/modules/world/domain/value-objects/world-id.value-object.js';

export class FakeAuthRepository implements AuthRepositoryPort {
  private byId = new Map<string, User>();
  private byEmail = new Map<string, User>();

  async findById(userId: UserId): Promise<User | null> {
    return this.byId.get(userId.getValue()) ?? null;
  }

  async findByEmail(email: Email): Promise<User | null> {
    return this.byEmail.get(email.getValue()) ?? null;
  }

  async save(user: User): Promise<void> {
    this.byId.set(user.getUserId().getValue(), user);
    this.byEmail.set(user.getEmail().getValue(), user);
  }
}

export class FakeSessionService implements SessionServicePort {
  private sessions = new Map<string, SessionInfo>();
  private authRepository: AuthRepositoryPort;

  constructor(authRepository: AuthRepositoryPort) {
    this.authRepository = authRepository;
  }

  async createSession(
    userId: UserId,
    durationMs: number = 7 * 24 * 60 * 60 * 1000
  ): Promise<{ sessionId: string; expiresAt: Date }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const user = await this.authRepository.findById(userId);
    if (!user) {
      throw new Error('User not found for session creation');
    }
    const expiresAt = new Date(Date.now() + durationMs);
    this.sessions.set(token, {
      userId: user.getUserId(),
      email: user.getEmail(),
      role: user.getRole(),
      expiresAt,
    });
    return { sessionId: token, expiresAt };
  }

  async validateSession(token: string): Promise<SessionInfo | null> {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    // Re-resolve the user on every validation, mirroring the real
    // SessionService which JOINs the users table — so role changes
    // (e.g. reader -> creator upgrades) apply to live sessions immediately.
    const user = await this.authRepository.findById(session.userId);
    if (!user) {
      return null;
    }
    return {
      userId: user.getUserId(),
      email: user.getEmail(),
      role: user.getRole(),
      expiresAt: session.expiresAt,
    };
  }

  async revokeSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  getCookieOptions(secure: boolean, expiresAt?: Date) {
    const options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'strict';
      path: string;
      maxAge?: number;
    } = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
    if (expiresAt) {
      options.maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    }
    return options;
  }

  getVerifier(): SessionVerifier {
    return (token: string) => this.validateSession(token);
  }
}

export class FakeWorldRepository implements WorldRepositoryPort {
  private worlds = new Map<string, World>();

  async findById(worldId: WorldId): Promise<World | null> {
    return this.worlds.get(worldId.getValue()) ?? null;
  }

  async findByCreatorId(creatorId: UserId): Promise<World[]> {
    return [...this.worlds.values()].filter((w) => w.getCreatorId().equals(creatorId));
  }

  async save(world: World): Promise<void> {
    this.worlds.set(world.getWorldId().getValue(), world);
  }
}
