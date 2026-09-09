/**
 * Ranks a candidate against a typed query for the AM Team comboboxes.
 *
 * Lower scores sort first, and `null` means the candidate does not match at all.
 * Matching is by word and by substring, never by scattered characters: an exact,
 * prefix or substring hit wins outright, then every typed word has to be found
 * inside a word of the candidate, and finally the typed letters may spell the
 * candidate's initials so "cl" still finds "Crack Longitudinal".
 *
 * Matching loose subsequences - "cl" also accepting "Collapse" or "Camera Lost" -
 * made a one or two letter query match nearly the whole dictionary, which is
 * indistinguishable from no filtering at all.
 */
function normalized(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function fuzzyMatchScore(option: string, query: string): number | null {
  const candidate = normalized(option)
  const search = normalized(query)
  if (!search) return 0
  if (candidate === search) return -100
  if (candidate.startsWith(search)) return -75
  const containedAt = candidate.indexOf(search)
  if (containedAt >= 0) return -50 + containedAt

  const words = candidate.split(' ').filter(Boolean)
  const terms = search.split(' ').filter(Boolean)

  // Every typed word must live inside a word of the candidate, so "long crack" finds
  // "Crack Longitudinal" whichever order the reviewer types the two words in.
  const wordPositions = terms.map((term) => words.findIndex((word) => word.includes(term)))
  if (wordPositions.every((position) => position >= 0)) {
    return -25 + wordPositions.reduce((total, position) => total + position, 0)
  }

  // Initials, for the one-word shorthand reviewers actually use.
  if (terms.length === 1 && terms[0].length >= 2 && terms[0].length <= words.length) {
    const initials = words.map((word) => word[0]).join('')
    const initialsAt = initials.indexOf(terms[0])
    if (initialsAt >= 0) return -10 + initialsAt
  }

  return null
}
