import { ChoiceId } from '../value-objects/choice-id.value-object.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { SceneId } from '../value-objects/scene-id.value-object.js';
import { ConditionPayload, ConditionSchema, MutationPayload, MutationSchema } from '../value-objects/world-schemas.js';

export interface ChoiceProps {
  choiceId: ChoiceId;
  worldId: WorldId;
  sceneId: SceneId;
  targetSceneId: SceneId;
  text: string;
  conditions?: ConditionPayload;
  mutations?: MutationPayload;
  sortOrder?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Choice {
  private readonly choiceId: ChoiceId;
  private readonly worldId: WorldId;
  private readonly sceneId: SceneId;
  private targetSceneId: SceneId;
  private text: string;
  private conditions: ConditionPayload;
  private mutations: MutationPayload;
  private sortOrder: number;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: ChoiceProps) {
    if (!props.text || typeof props.text !== 'string' || props.text.trim().length === 0) {
      throw new Error('Choice text cannot be empty');
    }
    const order = props.sortOrder ?? 0;
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new Error('Choice sortOrder must be a finite number');
    }
    const validatedConditions = ConditionSchema.parse(props.conditions ?? {});
    const validatedMutations = MutationSchema.parse(props.mutations ?? {});

    this.choiceId = props.choiceId;
    this.worldId = props.worldId;
    this.sceneId = props.sceneId;
    this.targetSceneId = props.targetSceneId;
    this.text = props.text.trim();
    this.conditions = structuredClone(validatedConditions);
    this.mutations = structuredClone(validatedMutations);
    this.sortOrder = order;
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
    this.updatedAt = props.updatedAt ? new Date(props.updatedAt.getTime()) : new Date();
  }

  public static create(props: ChoiceProps): Choice {
    return new Choice(props);
  }

  public getChoiceId(): ChoiceId {
    return this.choiceId;
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getSceneId(): SceneId {
    return this.sceneId;
  }

  public getTargetSceneId(): SceneId {
    return this.targetSceneId;
  }

  public getText(): string {
    return this.text;
  }

  public getConditions(): ConditionPayload {
    return structuredClone(this.conditions);
  }

  public getMutations(): MutationPayload {
    return structuredClone(this.mutations);
  }

  public getSortOrder(): number {
    return this.sortOrder;
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public updateText(text: string): void {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Choice text cannot be empty');
    }
    this.text = text.trim();
    this.updatedAt = new Date();
  }

  public updateTargetSceneId(targetSceneId: SceneId): void {
    this.targetSceneId = targetSceneId;
    this.updatedAt = new Date();
  }

  public updateConditions(conditions: ConditionPayload): void {
    const validated = ConditionSchema.parse(conditions);
    this.conditions = structuredClone(validated);
    this.updatedAt = new Date();
  }

  public updateMutations(mutations: MutationPayload): void {
    const validated = MutationSchema.parse(mutations);
    this.mutations = structuredClone(validated);
    this.updatedAt = new Date();
  }

  public updateSortOrder(sortOrder: number): void {
    if (typeof sortOrder !== 'number' || !Number.isFinite(sortOrder)) {
      throw new Error('Choice sortOrder must be a finite number');
    }
    this.sortOrder = sortOrder;
    this.updatedAt = new Date();
  }

  public equals(other: Choice | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.choiceId.equals(other.getChoiceId());
  }
}
