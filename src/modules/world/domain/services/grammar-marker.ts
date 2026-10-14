/**
 * Grammar marker presence tracking (Task G1a, ADR-015 §10 B12).
 *
 * The transport schema keeps `condition_grammar_version` optional with NO
 * default. This helper derives both facts the execution policy needs from
 * parsed canon data:
 * - `hadMarker`: did the stored snapshot actually contain the marker?
 * - `effectiveVersion`: the grammar version to dispatch on (1 when absent).
 *
 * The failure POLICY is selected by `hadMarker`, not by the defaulted
 * value: absent → legacy fail-closed policy; present → v1 invariant policy.
 */
export interface GrammarMarkerInfo {
  readonly hadMarker: boolean;
  readonly effectiveVersion: 1;
}

export function getGrammarMarker(canonData: unknown): GrammarMarkerInfo {
  const marker =
    canonData !== null && typeof canonData === 'object'
      ? (canonData as { condition_grammar_version?: unknown }).condition_grammar_version
      : undefined;
  return { hadMarker: marker !== undefined, effectiveVersion: 1 };
}
