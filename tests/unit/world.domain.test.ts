import { describe, it, expect } from 'vitest';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { CharacterId } from '../../src/modules/world/domain/value-objects/character-id.value-object.js';
import { ChapterId } from '../../src/modules/world/domain/value-objects/chapter-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { CharacterRole, CharacterRoleSchema } from '../../src/modules/world/domain/value-objects/character-role.value-object.js';
import { WorldStatus } from '../../src/modules/world/domain/value-objects/world-status.value-object.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { Character } from '../../src/modules/world/domain/entities/character.entity.js';
import { Chapter } from '../../src/modules/world/domain/entities/chapter.entity.js';
import { Scene } from '../../src/modules/world/domain/entities/scene.entity.js';
import { Choice } from '../../src/modules/world/domain/entities/choice.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { WorldMetadataSchema, ConditionSchema, MutationSchema, CharacterAttributesSchema, SceneMetadataSchema } from '../../src/modules/world/domain/value-objects/world-schemas.js';

describe('World Domain: Value Objects & Entities', () => {
  const validUuid1 = '123e4567-e89b-42d3-a456-426614174000';
  const validUuid2 = '987fcdeb-5022-42d3-a456-426614174001';
  const validUuid3 = '11111111-2222-4233-8444-555555555555';

  describe('Value Objects & Schemas', () => {
    it('should validate WorldId', () => {
      const id = new WorldId(validUuid1);
      expect(id.getValue()).toBe(validUuid1);
      expect(id.equals(new WorldId(validUuid1))).toBe(true);
      expect(id.equals(new WorldId(validUuid2))).toBe(false);
      expect(() => new WorldId('invalid')).toThrowError(/Invalid WorldId/);
    });

    it('should validate CharacterId', () => {
      const id = new CharacterId(validUuid1);
      expect(id.getValue()).toBe(validUuid1);
      expect(id.equals(new CharacterId(validUuid1))).toBe(true);
      expect(() => new CharacterId('')).toThrowError(/CharacterId cannot be empty/);
    });

    it('should validate ChapterId', () => {
      const id = new ChapterId(validUuid1);
      expect(id.getValue()).toBe(validUuid1);
      expect(id.equals(new ChapterId(validUuid1))).toBe(true);
      expect(() => new ChapterId('bad')).toThrowError(/Invalid ChapterId/);
    });

    it('should validate SceneId', () => {
      const id = new SceneId(validUuid1);
      expect(id.getValue()).toBe(validUuid1);
      expect(id.equals(new SceneId(validUuid1))).toBe(true);
      expect(() => new SceneId('bad')).toThrowError(/Invalid SceneId/);
    });

    it('should validate ChoiceId', () => {
      const id = new ChoiceId(validUuid1);
      expect(id.getValue()).toBe(validUuid1);
      expect(id.equals(new ChoiceId(validUuid1))).toBe(true);
      expect(() => new ChoiceId('bad')).toThrowError(/Invalid ChoiceId/);
    });

    it('should validate CharacterRole (standard, custom, strict snake_case serialization & schema rejections)', () => {
      const role1 = new CharacterRole(' protagonist ');
      expect(role1.getRoleType()).toBe('protagonist');
      expect(role1.getCustomRoleName()).toBeNull();
      expect(role1.equals(new CharacterRole('PROTAGONIST'))).toBe(true);

      const customRole = new CharacterRole('custom', '  Mage  ');
      expect(customRole.getRoleType()).toBe('custom');
      expect(customRole.getCustomRoleName()).toBe('Mage');
      expect(customRole.equals(new CharacterRole('CUSTOM', 'mage'))).toBe(true);

      // Snake case round trip via fromJson / toJson
      const jsonObj = { role_type: 'custom', custom_role_name: ' Warrior ' };
      const parsedRole = CharacterRole.fromJson(jsonObj);
      expect(parsedRole.getRoleType()).toBe('custom');
      expect(parsedRole.getCustomRoleName()).toBe('Warrior');
      expect(parsedRole.toJson()).toEqual({ role_type: 'custom', custom_role_name: 'Warrior' });

      // Schema strict checks: unknown fields, camelCase aliases, whitespace rejections
      expect(() => CharacterRoleSchema.parse({ role_type: 'custom', custom_role_name: '   ' })).toThrow();
      expect(() => CharacterRoleSchema.parse({ role_type: 'protagonist', custom_role_name: 'Mage' })).toThrow();
      expect(() => CharacterRoleSchema.parse({ role_type: 'custom', custom_role_name: 'Mage', extra: 'bad' })).toThrow();
      expect(() => CharacterRoleSchema.parse({ roleType: 'custom', customRoleName: 'Mage' } as any)).toThrow();

      // Constructor rejections
      expect(() => new CharacterRole('unknown-role')).toThrowError(/Invalid CharacterRole type/);
      expect(() => new CharacterRole('custom', '')).toThrowError(/Custom role requires a non-blank custom_role_name/);
      expect(() => new CharacterRole('custom', '   ')).toThrowError(/Custom role requires a non-blank custom_role_name/);
      expect(() => new CharacterRole('protagonist', 'Mage')).toThrowError(/must not include custom_role_name/);
      expect(() => new CharacterRole('protagonist', '   ')).toThrowError(/must not include custom_role_name/);
    });

    it('should validate WorldStatus', () => {
      const status = new WorldStatus(' PUBLISHED ');
      expect(status.getValue()).toBe('published');
      expect(status.equals(new WorldStatus('published'))).toBe(true);
      expect(() => new WorldStatus('archived')).toThrowError(/Invalid WorldStatus/);
    });

    it('should reject invalid top-level non-object payloads in schema validation', () => {
      expect(() => WorldMetadataSchema.parse('not-an-object')).toThrow();
      expect(() => WorldMetadataSchema.parse(null)).toThrow();
      expect(() => CharacterAttributesSchema.parse(undefined)).toThrow();
    });

    it('G1: condition/mutation schemas accept any JSON value (loose transport)', () => {
      // Arrays are valid now (mutations are arrays in the v1 grammar).
      expect(ConditionSchema.parse([1, 2, 3])).toEqual([1, 2, 3]);
      expect(MutationSchema.parse([{ op: 'set', var: 'x', value: 1 }])).toEqual([
        { op: 'set', var: 'x', value: 1 },
      ]);
      // Non-JSON still rejected.
      expect(() => ConditionSchema.parse(undefined)).toThrow();
      expect(() => MutationSchema.parse(() => 1)).toThrow();
      expect(() => ConditionSchema.parse(NaN)).toThrow();
    });

    it('should validate dedicated WorldMetadataSchema boundaries and depth definition', () => {
      // 1. Valid root object within limits (depth 1, primitives, arrays)
      const validMeta = {
        genre: 'cyberpunk',
        tags: ['neon', 'dystopia'],
        rating: 5,
        isActive: true,
        extra: null,
      };
      expect(WorldMetadataSchema.parse(validMeta)).toEqual(validMeta);

      // 2. Reject non-finite numbers (NaN, Infinity, -Infinity)
      expect(() => WorldMetadataSchema.parse({ val: NaN })).toThrow();
      expect(() => WorldMetadataSchema.parse({ val: Infinity })).toThrow();
      expect(() => WorldMetadataSchema.parse({ val: -Infinity })).toThrow();

      // 3. String length limit: 1000 characters accepted, 1001 rejected
      const str1000 = 'x'.repeat(1000);
      expect(WorldMetadataSchema.parse({ note: str1000 })).toEqual({ note: str1000 });
      const str1001 = 'x'.repeat(1001);
      expect(() => WorldMetadataSchema.parse({ note: str1001 })).toThrow(/Metadata string cannot exceed 1000 characters/);

      // 4. Top-level keys limit: 50 keys accepted, 51 rejected
      const obj50Keys: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        obj50Keys[`k${i}`] = `v${i}`;
      }
      expect(Object.keys(WorldMetadataSchema.parse(obj50Keys))).toHaveLength(50);
      const obj51Keys: Record<string, string> = { ...obj50Keys, k50: 'extra' };
      expect(() => WorldMetadataSchema.parse(obj51Keys)).toThrow(/World metadata cannot exceed 50 top-level keys/);

      // 5. Array items limit: 50 items accepted, 51 rejected
      const arr50 = Array.from({ length: 50 }, (_, i) => `item${i}`);
      expect(WorldMetadataSchema.parse({ list: arr50 })).toEqual({ list: arr50 });
      const arr51 = [...arr50, 'item50'];
      expect(() => WorldMetadataSchema.parse({ list: arr51 })).toThrow(/Metadata array cannot exceed 50 items/);

      // 6. Nesting depth boundaries:
      // Depth 1: Root object { a: ... }
      // Depth 2: { a: { b: ... } } (allowed object)
      // Depth 3: { a: { b: 'literal' } } or { a: { b: ['literal'] } } (allowed leaf values)
      const validDepth3 = {
        level1: {
          level2: {
            leaf: 'value',
            leafArr: ['a', 'b'],
          },
        },
      };
      expect(WorldMetadataSchema.parse(validDepth3)).toEqual(validDepth3);

      // Depth 4: { a: { b: { c: { d: 'too-deep' } } } } -> strictly rejected
      const invalidDepth4 = {
        level1: {
          level2: {
            level3: {
              tooDeep: 'value',
            },
          },
        },
      };
      expect(() => WorldMetadataSchema.parse(invalidDepth4 as any)).toThrow();

      // Child object keys limit: max 50 keys in depth 2 object
      const childObj51Keys: Record<string, string> = {};
      for (let i = 0; i < 51; i++) {
        childObj51Keys[`sub${i}`] = 'val';
      }
      expect(() => WorldMetadataSchema.parse({ child: childObj51Keys })).toThrow(/Metadata child object cannot exceed 50 keys/);
    });

    it('should maintain regression behavior for Condition, Mutation, CharacterAttributes and SceneMetadata schemas', () => {
      // ConditionSchema and MutationSchema continue to allow deeper recursive structures as arbitrary jsonObjectSchema
      const deepCondition = {
        rule: {
          nested: {
            deeply: {
              veryDeep: 123,
            },
          },
        },
      };
      expect(ConditionSchema.parse(deepCondition)).toEqual(deepCondition);
      expect(MutationSchema.parse(deepCondition)).toEqual(deepCondition);
      expect(CharacterAttributesSchema.parse(deepCondition)).toEqual(deepCondition);
      expect(SceneMetadataSchema.parse(deepCondition)).toEqual(deepCondition);
    });
  });

  describe('World Entity & Encapsulation / Atomicity / Input Defensiveness', () => {
    it('should create and update World entity with input defensiveness, getter isolation, and failure atomicity', () => {
      const worldId = new WorldId(validUuid1);
      const creatorId = new UserId(validUuid2);
      const inputMeta = { genre: 'cyberpunk', settings: { time: 'night' } };
      const world = World.create({
        worldId,
        creatorId,
        title: ' Cyberpunk Neon City ',
        description: ' A dystopian metropolis ',
        metadata: inputMeta,
      });

      // Verify input mutation after create does not affect internal entity state
      inputMeta.genre = 'corrupted';
      expect(world.getMetadata().genre).toBe('cyberpunk');

      expect(world.getWorldId().equals(worldId)).toBe(true);
      expect(world.getCreatorId().equals(creatorId)).toBe(true);
      expect(world.getTitle()).toBe('Cyberpunk Neon City');
      expect(world.getDescription()).toBe('A dystopian metropolis');
      expect(world.getMetadata()).toEqual({ genre: 'cyberpunk', settings: { time: 'night' } });
      expect(world.getStatus().getValue()).toBe('draft');

      // Verify nested deep cloning in getter prevents external mutation
      const meta = world.getMetadata();
      (meta.settings as any).time = 'morning';
      expect(world.getMetadata()).toEqual({ genre: 'cyberpunk', settings: { time: 'night' } });

      // Verify failed update preserves existing state (atomicity) and updatedAt timestamp
      const priorMetadata = world.getMetadata();
      const priorUpdatedAt = world.getUpdatedAt();
      const inputUpdate = { genre: 'invalid-attempt' };
      inputUpdate.genre = 'corrupted-update';
      expect(() => world.updateMetadata('invalid-non-object' as any)).toThrow();
      expect(world.getMetadata()).toEqual(priorMetadata);
      expect(world.getUpdatedAt().getTime()).toBe(priorUpdatedAt.getTime());

      world.updateTitle(' New Title ');
      expect(world.getTitle()).toBe('New Title');

      world.updateDescription(' New desc ');
      expect(world.getDescription()).toBe('New desc');

      world.updateMetadata({ genre: 'sci-fi', theme: 'dark' });
      expect(world.getMetadata()).toEqual({ genre: 'sci-fi', theme: 'dark' });

      world.publish();
      expect(world.getStatus().getValue()).toBe('published');

      world.revertToDraft();
      expect(world.getStatus().getValue()).toBe('draft');

      const world2 = World.create({ worldId, creatorId, title: 'Other' });
      expect(world.equals(world2)).toBe(true);
      expect(world.equals(null)).toBe(false);
    });

    it('should throw error on empty world title', () => {
      expect(() =>
        World.create({
          worldId: new WorldId(validUuid1),
          creatorId: new UserId(validUuid2),
          title: '   ',
        })
      ).toThrowError(/World title cannot be empty/);
    });

    it('should enforce 10000-character description limit, normalization to null, and reject non-string runtime inputs', () => {
      const worldId = new WorldId(validUuid1);
      const creatorId = new UserId(validUuid2);

      // 1. Accepts exactly 10,000 characters
      const desc10000 = 'd'.repeat(10000);
      const world = World.create({
        worldId,
        creatorId,
        title: 'Valid World',
        description: desc10000,
      });
      expect(world.getDescription()).toBe(desc10000);
      expect(world.getDescription()?.length).toBe(10000);

      // 2. Rejects 10,001 characters on create
      const desc10001 = 'd'.repeat(10001);
      expect(() =>
        World.create({
          worldId,
          creatorId,
          title: 'Valid World',
          description: desc10001,
        })
      ).toThrowError(/World description cannot exceed 10000 characters/);

      // 3. Rejects 10,001 characters on updateDescription
      expect(() => world.updateDescription(desc10001)).toThrowError(/World description cannot exceed 10000 characters/);
      expect(world.getDescription()).toBe(desc10000); // Prior description preserved

      // 4. Normalizes empty or whitespace-only strings to null on create
      const worldEmptyDesc = World.create({
        worldId,
        creatorId,
        title: 'Empty Desc World',
        description: '    ',
      });
      expect(worldEmptyDesc.getDescription()).toBeNull();

      const worldBlankDesc = World.create({
        worldId,
        creatorId,
        title: 'Blank Desc World',
        description: '',
      });
      expect(worldBlankDesc.getDescription()).toBeNull();

      // 5. Normalizes empty or whitespace-only strings to null on update
      world.updateDescription('   ');
      expect(world.getDescription()).toBeNull();

      world.updateDescription(null);
      expect(world.getDescription()).toBeNull();

      // 6. Trims leading/trailing whitespace on valid descriptions
      world.updateDescription('  Valid trimmed description  ');
      expect(world.getDescription()).toBe('Valid trimmed description');

      // 7. Rejects non-string runtime inputs safely
      expect(() =>
        World.create({
          worldId,
          creatorId,
          title: 'Bad Type World',
          description: 12345 as any,
        })
      ).toThrowError(/World description must be a string/);

      expect(() => world.updateDescription({ bad: 'input' } as any)).toThrowError(
        /World description must be a string/
      );
    });
  });

  describe('Character Entity', () => {
    it('should create and update Character entity with role multiplicity, custom roles, uniqueness checks, and failure atomicity', () => {
      const charId = new CharacterId(validUuid1);
      const worldId = new WorldId(validUuid2);
      const roles = [
        new CharacterRole('protagonist'),
        new CharacterRole('custom', 'Mage'),
        new CharacterRole('custom', 'Healer'),
      ];
      const inputAttrs = { tier: 1, stats: { hp: 100 } };

      const character = Character.create({
        characterId: charId,
        worldId,
        name: ' Alex Chen ',
        roleTypes: roles,
        description: ' Hacker protagonist ',
        attributes: inputAttrs,
      });

      expect(character.getRoleTypes().length).toBe(3);
      expect(character.getRoleTypes()[1].getCustomRoleName()).toBe('Mage');

      // Reject duplicate standard role
      expect(() =>
        Character.create({
          characterId: charId,
          worldId,
          name: 'Dupe',
          roleTypes: [new CharacterRole('protagonist'), new CharacterRole('protagonist')],
        })
      ).toThrowError(/Duplicate character role assignment is prohibited/);

      // Reject duplicate custom role (case-insensitive)
      expect(() =>
        Character.create({
          characterId: charId,
          worldId,
          name: 'DupeCustom',
          roleTypes: [new CharacterRole('custom', 'Mage'), new CharacterRole('custom', 'mage')],
        })
      ).toThrowError(/Duplicate character role assignment is prohibited/);

      // Verify failed update atomicity & updatedAt preservation
      const priorRoles = character.getRoleTypes();
      const priorUpdatedAt = character.getUpdatedAt();
      expect(() => character.updateRoleTypes([new CharacterRole('protagonist'), new CharacterRole('protagonist')])).toThrow();
      expect(character.getRoleTypes().length).toBe(priorRoles.length);
      expect(character.getUpdatedAt().getTime()).toBe(priorUpdatedAt.getTime());

      character.updateRoleTypes([new CharacterRole('companion')]);
      expect(character.getRoleTypes().length).toBe(1);
      expect(character.getRoleTypes()[0].getRoleType()).toBe('companion');
    });

    it('should throw error if character name or roles are empty', () => {
      expect(() =>
        Character.create({
          characterId: new CharacterId(validUuid1),
          worldId: new WorldId(validUuid2),
          name: '',
          roleTypes: [new CharacterRole('villain')],
        })
      ).toThrowError(/Character name cannot be empty/);

      expect(() =>
        Character.create({
          characterId: new CharacterId(validUuid1),
          worldId: new WorldId(validUuid2),
          name: 'Name',
          roleTypes: [],
        })
      ).toThrowError(/Character must have at least one role type/);
    });
  });

  describe('Chapter Entity', () => {
    it('should create and update Chapter entity with finite sortOrder validation', () => {
      const chapterId = new ChapterId(validUuid1);
      const worldId = new WorldId(validUuid2);

      const chapter = Chapter.create({
        chapterId,
        worldId,
        title: ' Chapter One ',
        sortOrder: 1,
      });

      expect(chapter.getChapterId().equals(chapterId)).toBe(true);
      expect(chapter.getWorldId().equals(worldId)).toBe(true);
      expect(chapter.getTitle()).toBe('Chapter One');
      expect(chapter.getSortOrder()).toBe(1);

      chapter.updateTitle(' The Beginning ');
      expect(chapter.getTitle()).toBe('The Beginning');

      chapter.updateSortOrder(2);
      expect(chapter.getSortOrder()).toBe(2);

      expect(() => Chapter.create({ chapterId, worldId, title: 'T', sortOrder: NaN })).toThrowError(/sortOrder must be a finite number/);
      expect(() => chapter.updateSortOrder(Infinity)).toThrowError(/sortOrder must be a finite number/);
      expect(() => chapter.updateSortOrder(-Infinity)).toThrowError(/sortOrder must be a finite number/);
    });

    it('should throw error on empty chapter title', () => {
      expect(() =>
        Chapter.create({
          chapterId: new CharacterId(validUuid1),
          worldId: new WorldId(validUuid2),
          title: '',
        })
      ).toThrowError(/Chapter title cannot be empty/);
    });
  });

  describe('Scene Entity', () => {
    it('should create and update Scene entity with input defensiveness and getter isolation', () => {
      const sceneId = new SceneId(validUuid1);
      const worldId = new WorldId(validUuid2);
      const chapterId = new ChapterId(validUuid3);
      const inputMeta = { ambient: 'dark', config: { music: 'suspense' } };

      const scene = Scene.create({
        sceneId,
        worldId,
        chapterId,
        title: ' Awakening ',
        prose: ' You wake up in a dark room. ',
        metadata: inputMeta,
        isEnding: false,
      });

      // Verify input mutation after create does not affect state
      inputMeta.ambient = 'corrupted';
      expect(scene.getMetadata().ambient).toBe('dark');

      expect(scene.getSceneId().equals(sceneId)).toBe(true);
      expect(scene.getWorldId().equals(worldId)).toBe(true);
      expect(scene.getChapterId().equals(chapterId)).toBe(true);
      expect(scene.getTitle()).toBe('Awakening');
      expect(scene.getProse()).toBe(' You wake up in a dark room. ');
      expect(scene.getMetadata()).toEqual({ ambient: 'dark', config: { music: 'suspense' } });
      expect(scene.getIsEnding()).toBe(false);

      // Verify deep cloning
      const meta = scene.getMetadata();
      (meta.config as any).music = 'action';
      expect(scene.getMetadata()).toEqual({ ambient: 'dark', config: { music: 'suspense' } });

      // Verify failed update atomicity & updatedAt preservation
      const priorMeta = scene.getMetadata();
      const priorUpdatedAt = scene.getUpdatedAt();
      expect(() => scene.updateMetadata('bad' as any)).toThrow();
      expect(scene.getMetadata()).toEqual(priorMeta);
      expect(scene.getUpdatedAt().getTime()).toBe(priorUpdatedAt.getTime());

      scene.updateTitle(' New Scene ');
      expect(scene.getTitle()).toBe('New Scene');

      scene.updateProse(' Updated prose ');
      expect(scene.getProse()).toBe(' Updated prose ');

      scene.setIsEnding(true);
      expect(scene.getIsEnding()).toBe(true);
    });
  });

  describe('Choice Entity', () => {
    it('should create and update Choice entity with input defensiveness, getter isolation, finite sortOrder, and failure atomicity', () => {
      const choiceId = new ChoiceId(validUuid1);
      const worldId = new WorldId(validUuid2);
      const sceneId = new SceneId(validUuid3);
      const targetSceneId = new SceneId('22222222-3333-4444-8555-666666666666');
      const inputCond = { flag: 'unlocked', details: { required_key: 'brass' } };
      const inputMut = { set_flag: { door_open: true } };

      const choice = Choice.create({
        choiceId,
        worldId,
        sceneId,
        targetSceneId,
        text: ' Open the door ',
        conditions: inputCond,
        mutations: inputMut,
        sortOrder: 0,
      });

      // Verify input mutation after create does not affect state
      inputCond.flag = 'corrupted';
      expect(choice.getConditions().flag).toBe('unlocked');

      expect(choice.getChoiceId().equals(choiceId)).toBe(true);
      expect(choice.getWorldId().equals(worldId)).toBe(true);
      expect(choice.getSceneId().equals(sceneId)).toBe(true);
      expect(choice.getTargetSceneId().equals(targetSceneId)).toBe(true);
      expect(choice.getText()).toBe('Open the door');
      expect(choice.getConditions()).toEqual({ flag: 'unlocked', details: { required_key: 'brass' } });
      expect(choice.getMutations()).toEqual({ set_flag: { door_open: true } });
      expect(choice.getSortOrder()).toBe(0);

      // Verify deep cloning of conditions
      const cond = choice.getConditions();
      (cond.details as any).required_key = 'gold';
      expect(choice.getConditions()).toEqual({ flag: 'unlocked', details: { required_key: 'brass' } });

      // Verify failed update atomicity & updatedAt preservation
      const priorConds = choice.getConditions();
      const priorUpdatedAt = choice.getUpdatedAt();
      expect(() => choice.updateConditions(undefined as any)).toThrow();
      expect(choice.getConditions()).toEqual(priorConds);
      expect(choice.getUpdatedAt().getTime()).toBe(priorUpdatedAt.getTime());

      choice.updateText(' Knock on door ');
      expect(choice.getText()).toBe('Knock on door');

      choice.updateConditions({ count: { '>': 5 } });
      expect(choice.getConditions()).toEqual({ count: { '>': 5 } });

      expect(() => Choice.create({ choiceId, worldId, sceneId, targetSceneId, text: 'T', sortOrder: NaN })).toThrowError(/sortOrder must be a finite number/);
      expect(() => choice.updateSortOrder(Infinity)).toThrowError(/sortOrder must be a finite number/);
    });
  });
});
