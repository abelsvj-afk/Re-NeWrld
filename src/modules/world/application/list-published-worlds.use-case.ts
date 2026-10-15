import { WorldRepositoryPort, PublishedWorldFilters } from '../domain/ports/world.repository.port.js';
import { WorldGenreSchema } from '../domain/value-objects/world-schemas.js';
import { World } from '../domain/entities/world.entity.js';

export interface ListPublishedWorldsInput {
  genre?: string;
  tag?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PublishedWorldSummary {
  id: string;
  title: string;
  description: string | null;
  genre: string | null;
  tags: string[];
  updatedAt: string;
}

/**
 * Reader catalog of published worlds across all creators (H-UX2).
 * Drafts are excluded by the repository query. Filters apply before
 * pagination; ordering is deterministic.
 */
export class ListPublishedWorldsUseCase {
  constructor(private readonly worldRepository: WorldRepositoryPort) {}

  public async execute(input: ListPublishedWorldsInput): Promise<PublishedWorldSummary[]> {
    // Validate genre against the closed enum; unknown genre → 400 via Zod.
    let genre: string | undefined;
    if (input.genre !== undefined) {
      genre = WorldGenreSchema.parse(input.genre);
    }

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);

    const filters: PublishedWorldFilters = {
      genre,
      tag: input.tag?.trim().toLowerCase() || undefined,
      search: input.search?.trim() || undefined,
      limit,
      offset,
    };

    const worlds: World[] = await this.worldRepository.findPublished(filters);
    return worlds.map((w) => {
      const metadata = w.getMetadata() as { genre?: string; tags?: string[] };
      return {
        id: w.getWorldId().getValue(),
        title: w.getTitle(),
        description: w.getDescription(),
        genre: metadata.genre ?? null,
        tags: metadata.tags ?? [],
        updatedAt: w.getUpdatedAt().toISOString(),
      };
    });
  }
}
