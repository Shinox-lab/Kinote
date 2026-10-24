export interface PresencePerson {
  id: string;
  name: string;
  accent: string;
  tint: string;
}

/** Six author slots, in the order the design uses them: violet, green, amber, blue, pink, teal. */
const SLOTS = [0, 5, 1, 4, 3, 2] as const;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A stable tint for a person, keyed by their user id (the same colour as their changes and cursor family). */
export function presenceTint(id: string): { accent: string; tint: string } {
  const slot = SLOTS[hash(id) % SLOTS.length];
  return { accent: `var(--author-${slot})`, tint: `var(--author-${slot}-tint)` };
}

/** The three faces the strip shows, and how many more are behind +N. */
export function presenceStrip(people: readonly PresencePerson[], limit = 3): { shown: PresencePerson[]; more: number } {
  const shown = people.slice(0, limit);
  return { shown, more: people.length - shown.length };
}

/** "Ada Lovelace" reads AL; one name reads A; no name reads ?. */
export function initials(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return `${words[0]![0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
}

/**
 * The other people in the awareness: deduped by user id (two tabs are one
 * person), with the id/name our client puts in `lwUser` and the name/colour
 * BlockNote puts in `user` as a fallback. The signed-in person is left out.
 */
export function presencePeople(
  states: Iterable<[number, Record<string, unknown>]>,
  selfId: string | null
): PresencePerson[] {
  const seen = new Set<string>();
  const people: PresencePerson[] = [];
  for (const [clientId, state] of states) {
    const lw = state.lwUser as { id?: unknown; name?: unknown } | undefined;
    const blocknote = state.user as { name?: unknown } | undefined;
    const id = typeof lw?.id === 'string' ? lw.id : null;
    const name =
      (typeof lw?.name === 'string' && lw.name.trim()) ||
      (typeof blocknote?.name === 'string' && blocknote.name.trim()) ||
      'Someone';
    if (id !== null && id === selfId) continue;
    const key = id ?? `client-${clientId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ id: key, name, ...presenceTint(key) });
  }
  return people;
}
