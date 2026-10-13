import { z } from 'zod';

export type StandardRoleType = 'protagonist' | 'antagonist' | 'companion' | 'rival' | 'villain' | 'faction';
export type CharacterRoleType = StandardRoleType | 'custom';

const STANDARD_ROLES: StandardRoleType[] = [
  'protagonist',
  'antagonist',
  'companion',
  'rival',
  'villain',
  'faction',
];

export const CharacterRoleSchema = z.discriminatedUnion('role_type', [
  z.object({
    role_type: z.enum(STANDARD_ROLES as [StandardRoleType, ...StandardRoleType[]]),
    custom_role_name: z.undefined().optional(),
  }).strict(),
  z.object({
    role_type: z.literal('custom'),
    custom_role_name: z.string().trim().min(1, { message: 'Custom role name cannot be blank or empty' }),
  }).strict(),
]);

export type CharacterRoleProps = z.infer<typeof CharacterRoleSchema>;

export class CharacterRole {
  private readonly roleType: CharacterRoleType;
  private readonly customRoleName: string | null;

  constructor(roleType: string, customRoleName?: string | null) {
    if (!roleType || typeof roleType !== 'string') {
      throw new Error('CharacterRole role_type cannot be empty');
    }
    const trimmedType = roleType.trim().toLowerCase();

    if (STANDARD_ROLES.includes(trimmedType as StandardRoleType)) {
      if (customRoleName !== undefined && customRoleName !== null) {
        throw new Error(`Standard role '${trimmedType}' must not include custom_role_name`);
      }
      this.roleType = trimmedType as StandardRoleType;
      this.customRoleName = null;
    } else if (trimmedType === 'custom') {
      if (
        !customRoleName ||
        typeof customRoleName !== 'string' ||
        customRoleName.trim().length === 0
      ) {
        throw new Error("Custom role requires a non-blank custom_role_name");
      }
      const trimmedCustom = customRoleName.trim();
      if (trimmedCustom.length === 0) {
        throw new Error("Custom role requires a non-blank custom_role_name");
      }
      this.roleType = 'custom';
      this.customRoleName = trimmedCustom;
    } else {
      throw new Error(`Invalid CharacterRole type: ${roleType}. Must be one of: ${STANDARD_ROLES.join(', ')}, custom`);
    }
  }

  public static create(props: { role_type: string; custom_role_name?: string | null }): CharacterRole {
    const parsed = CharacterRoleSchema.parse(props);
    return new CharacterRole(parsed.role_type, parsed.custom_role_name);
  }

  public static fromJson(json: unknown): CharacterRole {
    const parsed = CharacterRoleSchema.parse(json);
    return new CharacterRole(parsed.role_type, parsed.custom_role_name);
  }

  public getRoleType(): CharacterRoleType {
    return this.roleType;
  }

  public getCustomRoleName(): string | null {
    return this.customRoleName;
  }

  public toJson(): { role_type: CharacterRoleType; custom_role_name?: string } {
    const res: { role_type: CharacterRoleType; custom_role_name?: string } = { role_type: this.roleType };
    if (this.customRoleName !== null) {
      res.custom_role_name = this.customRoleName;
    }
    return res;
  }

  public equals(other: CharacterRole | null | undefined): boolean {
    if (!other) {
      return false;
    }
    if (this.roleType !== other.getRoleType()) {
      return false;
    }
    if (this.roleType === 'custom') {
      return (
        (this.customRoleName ?? '').toLowerCase() ===
        (other.getCustomRoleName() ?? '').toLowerCase()
      );
    }
    return true;
  }
}
