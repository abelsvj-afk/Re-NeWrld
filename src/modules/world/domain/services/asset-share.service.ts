/**
 * SHARE-1: Cross-world asset sharing (ADR-017 §4.7c)
 *
 * Allows an asset owned by one world to be referenced by other worlds.
 * Shared assets count toward the owner's quota only.
 */

import { withTransaction } from '../../../../shared/database/db.js';

export type ShareErrorCode =
  | 'ASSET_NOT_FOUND'       // 404
  | 'NOT_OWNER'             // 403 - only owner can share
  | 'ALREADY_SHARED'        // 409 - already shared with target
  | 'SELF_SHARE'            // 400 - cannot share with own world
  | 'SHARE_REFERENCED';     // 409 - cannot unshare while target has references

export class ShareError extends Error {
  public readonly code: ShareErrorCode;
  public readonly httpStatus: number;

  constructor(code: ShareErrorCode, message: string) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
    this.httpStatus =
      code === 'ASSET_NOT_FOUND' ? 404 :
      code === 'NOT_OWNER' ? 403 :
      code === 'SELF_SHARE' ? 400 : 409;
  }
}

export interface ShareDeps {
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Share an asset with another world.
 * Only the owning world can share.
 */
export async function shareAsset(
  assetId: string,
  ownerWorldId: string,
  targetWorldId: string,
  deps: ShareDeps
): Promise<void> {
  if (ownerWorldId === targetWorldId) {
    throw new ShareError('SELF_SHARE', 'Cannot share asset with its own world');
  }

  return withTransaction(async (tx) => {
    // Lock asset row
    const result = await tx.query(
      `SELECT asset_id, world_id, shared_with_worlds FROM world_media_assets
       WHERE asset_id = $1 FOR UPDATE`,
      [assetId]
    );

    if (result.rows.length === 0) {
      throw new ShareError('ASSET_NOT_FOUND', `Asset not found: ${assetId}`);
    }

    const asset = result.rows[0];
    if (asset.world_id !== ownerWorldId) {
      throw new ShareError('NOT_OWNER', 'Only the owning world can share an asset');
    }

    const sharedWith: string[] = asset.shared_with_worlds || [];
    if (sharedWith.includes(targetWorldId)) {
      throw new ShareError('ALREADY_SHARED', `Asset already shared with ${targetWorldId}`);
    }

    // Verify target world exists
    const targetCheck = await tx.query(
      `SELECT world_id FROM worlds WHERE world_id = $1`,
      [targetWorldId]
    );
    if (targetCheck.rows.length === 0) {
      throw new ShareError('ASSET_NOT_FOUND', `Target world not found: ${targetWorldId}`);
    }

    await tx.query(
      `UPDATE world_media_assets
       SET shared_with_worlds = array_append(shared_with_worlds, $2)
       WHERE asset_id = $1`,
      [assetId, targetWorldId]
    );

    deps.log('info', 'Asset shared', { assetId, ownerWorldId, targetWorldId });
  });
}

/**
 * Remove sharing for an asset.
 * Fails if the target world has active references to the asset.
 */
export async function unshareAsset(
  assetId: string,
  ownerWorldId: string,
  targetWorldId: string,
  deps: ShareDeps
): Promise<void> {
  return withTransaction(async (tx) => {
    const result = await tx.query(
      `SELECT asset_id, world_id, url, shared_with_worlds FROM world_media_assets
       WHERE asset_id = $1 FOR UPDATE`,
      [assetId]
    );

    if (result.rows.length === 0) {
      throw new ShareError('ASSET_NOT_FOUND', `Asset not found: ${assetId}`);
    }

    const asset = result.rows[0];
    if (asset.world_id !== ownerWorldId) {
      throw new ShareError('NOT_OWNER', 'Only the owning world can unshare an asset');
    }

    const sharedWith: string[] = asset.shared_with_worlds || [];
    if (!sharedWith.includes(targetWorldId)) {
      // Idempotent: not shared → success
      return;
    }

    // Check if target has active references
    const refs = await tx.query(
      `SELECT 'cover' AS role FROM worlds
       WHERE world_id = $2 AND metadata->>'coverArtUrl' = $1
       UNION
       SELECT 'illustration' AS role FROM scenes
       WHERE world_id = $2 AND metadata->>'illustrationUrl' = $1`,
      [asset.url, targetWorldId]
    );

    if (refs.rows.length > 0) {
      throw new ShareError(
        'SHARE_REFERENCED',
        `Cannot unshare: target world has active references to asset ${assetId}`
      );
    }

    await tx.query(
      `UPDATE world_media_assets
       SET shared_with_worlds = array_remove(shared_with_worlds, $2)
       WHERE asset_id = $1`,
      [assetId, targetWorldId]
    );

    deps.log('info', 'Asset unshared', { assetId, ownerWorldId, targetWorldId });
  });
}
