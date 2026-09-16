/**
 * Masks a living person's name for the public: the surname stays, the given name
 * is hidden entirely.
 *
 * "孔垂长" → "孔**", "王弗" → "王*", a lone character is left as-is. Deliberately
 * stronger than the light first-and-last masking used for a signed-in "family"
 * audience: this is shown to strangers about someone who never consented to be
 * named, so nothing of the given name is revealed. A two-character surname
 * (欧阳) loses its second character too — the safe direction to err.
 */
export function maskName(name: string): string {
  const trimmed = name.trim();
  const chars = [...trimmed];
  if (chars.length <= 1) return trimmed;
  return `${chars[0]}${"*".repeat(chars.length - 1)}`;
}
