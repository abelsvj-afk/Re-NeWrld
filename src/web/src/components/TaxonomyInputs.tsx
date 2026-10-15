import { WORLD_GENRES } from '../lib/api';

interface TaxonomyInputsProps {
  genre: string;
  setGenre: (g: string) => void;
  tagsInput: string;
  setTagsInput: (t: string) => void;
}

/**
 * Genre picker + tag input for world create/edit forms (H-UX2).
 * Tags are comma-separated freeform; normalized on submit.
 */
export function TaxonomyInputs({ genre, setGenre, tagsInput, setTagsInput }: TaxonomyInputsProps) {
  return (
    <>
      <div>
        <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">
          Genre <span className="normal-case tracking-normal opacity-60">(optional)</span>
        </label>
        <select
          value={genre}
          onChange={(e) => setGenre(e.target.value)}
          aria-label="World genre"
          className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all"
        >
          <option value="">Uncategorized</option>
          {WORLD_GENRES.map((g) => (
            <option key={g} value={g} className="capitalize">{g}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">
          Tags <span className="normal-case tracking-normal opacity-60">(optional, comma-separated)</span>
        </label>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="dark-fantasy, second-chances, slow-burn"
          aria-label="World tags"
          className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all"
        />
        <p className="text-[11px] text-ink-faint mt-1.5">Lowercase letters, numbers, and hyphens. Max 10 tags.</p>
      </div>
    </>
  );
}

/** Parse comma-separated tag input into a normalized array. */
export function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && /^[a-z0-9-]+$/.test(t))
    .slice(0, 10);
}
