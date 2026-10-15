import { describe, it, expect, vi } from 'vitest';
import { GenerateNarrationUseCase } from '../../src/modules/world/application/generate-narration.use-case.js';
import { proseToPlainText, sha256Hex } from '../../src/modules/world/infrastructure/elevenlabs.client.js';
import { Narration } from '../../src/modules/world/domain/entities/narration.entity.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { Scene } from '../../src/modules/world/domain/entities/scene.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { ChapterId } from '../../src/modules/world/domain/value-objects/chapter-id.value-object.js';
import { WorldStatus } from '../../src/modules/world/domain/value-objects/world-status.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';

const WORLD_ID = '11111111-1111-4111-8111-111111111111';
const SCENE_ID = '22222222-2222-4222-8222-222222222222';
const CREATOR_ID = '33333333-3333-4333-8333-333333333333';

function makeWorld() {
  return World.create({
    worldId: new WorldId(WORLD_ID),
    creatorId: new UserId(CREATOR_ID),
    title: 'Test',
    status: new WorldStatus('draft'),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function makeScene() {
  return Scene.create({
    sceneId: new SceneId(SCENE_ID),
    worldId: new WorldId(WORLD_ID),
    chapterId: new ChapterId('44444444-4444-4444-8444-444444444444'),
    title: 'S1',
    prose: '<p>Hello world.</p>',
    metadata: {},
    isEnding: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function deps(overrides: any = {}) {
  return {
    narrationRepository: {
      findCached: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockImplementation((n: Narration) => Promise.resolve(n)),
      sumCharactersThisMonth: vi.fn().mockResolvedValue(0),
    },
    sceneRepository: { findById: vi.fn().mockResolvedValue(makeScene()) },
    worldRepository: { findById: vi.fn().mockResolvedValue(makeWorld()) },
    elevenLabs: {
      synthesize: vi.fn().mockResolvedValue(Buffer.from('fake-mp3')),
      getRemainingQuota: vi.fn().mockResolvedValue(40000),
      isCircuitOpen: vi.fn().mockReturnValue(false),
    },
    storagePath: '/tmp/narration-test',
    monthlyCharCap: 40000,
    ...overrides,
  };
}

const input = {
  worldId: WORLD_ID,
  sceneId: SCENE_ID,
  creatorId: new UserId(CREATOR_ID),
  voiceId: 'voice123',
};

describe('GenerateNarrationUseCase', () => {
  it('returns cached audio without calling ElevenLabs', async () => {
    const cached = Narration.create({
      worldId: new WorldId(WORLD_ID),
      canonVersion: 0,
      sceneId: new SceneId(SCENE_ID),
      proseHash: sha256Hex('Hello world.'),
      voiceId: 'voice123',
      modelId: 'eleven_turbo_v2_5',
      audioPath: '/tmp/x.mp3',
      characterCount: 12,
    });
    const d = deps({ narrationRepository: {
      findCached: vi.fn().mockResolvedValue(cached),
      save: vi.fn(),
      sumCharactersThisMonth: vi.fn().mockResolvedValue(0),
    }});
    const uc = new GenerateNarrationUseCase(d as any);
    const out = await uc.execute(input);
    expect(out.status).toBe('cached');
    expect(d.elevenLabs.synthesize).not.toHaveBeenCalled();
  });

  it('rejects when monthly quota would be exceeded', async () => {
    const d = deps({ narrationRepository: {
      findCached: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
      sumCharactersThisMonth: vi.fn().mockResolvedValue(39995),
    }});
    const uc = new GenerateNarrationUseCase(d as any);
    await expect(uc.execute(input)).rejects.toThrow(/quota/i);
    expect(d.elevenLabs.synthesize).not.toHaveBeenCalled();
  });

  it('rejects when ElevenLabs reports insufficient quota', async () => {
    const d = deps({ elevenLabs: {
      synthesize: vi.fn(),
      getRemainingQuota: vi.fn().mockResolvedValue(5),
      isCircuitOpen: vi.fn().mockReturnValue(false),
    }});
    const uc = new GenerateNarrationUseCase(d as any);
    await expect(uc.execute(input)).rejects.toThrow(/quota/i);
  });

  it('rejects scenes over the 5000-char cap', async () => {
    const longScene = Scene.create({
      sceneId: new SceneId(SCENE_ID),
      worldId: new WorldId(WORLD_ID),
      chapterId: new ChapterId('44444444-4444-4444-8444-444444444444'),
      title: 'Long',
      prose: '<p>' + 'x'.repeat(6000) + '</p>',
      metadata: {},
      isEnding: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const d = deps({ sceneRepository: { findById: vi.fn().mockResolvedValue(longScene) } });
    const uc = new GenerateNarrationUseCase(d as any);
    await expect(uc.execute(input)).rejects.toThrow(/cap/i);
  });

  it('rejects when narration is not configured', async () => {
    const d = deps({ elevenLabs: null });
    const uc = new GenerateNarrationUseCase(d as any);
    await expect(uc.execute(input)).rejects.toThrow(/not configured/i);
  });
});

describe('proseToPlainText', () => {
  it('strips HTML to readable text', () => {
    expect(proseToPlainText('<p>Hello <em>world</em>.</p><p>Second.</p>'))
      .toBe('Hello world.\nSecond.');
  });
  it('is deterministic for hashing', () => {
    const a = sha256Hex('test');
    expect(a).toBe(sha256Hex('test'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
