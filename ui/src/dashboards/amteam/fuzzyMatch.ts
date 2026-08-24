/**
 * Ranks a candidate against a typed query for the AM Team comboboxes.
 *
 * Lower scores sort first, and `null` means the candidate does not match at all.
 * Exact, prefix and substring hits win outright; anything else falls back to a
 * subsequence match scored by how tightly the typed characters cluster, so
 * "cl" still finds "Crack Longitudinal".
 */
export function fuzzyMatchScore(option: string, query: string): number | null {
  const candidate = option.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const search = query.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!search) return 0
  if (candidate === search) return -100
  if (candidate.startsWith(search)) return -75
  const containedAt = candidate.indexOf(search)
  if (containedAt >= 0) return -50 + containedAt

  let candidateIndex = -1
  let gaps = 0
  for (const character of search.replaceAll(' ', '')) {
    const nextIndex = candidate.indexOf(character, candidateIndex + 1)
    if (nextIndex < 0) return null
    gaps += nextIndex - candidateIndex - 1
    candidateIndex = nextIndex
  }
  return gaps + candidateIndex / 100
}
