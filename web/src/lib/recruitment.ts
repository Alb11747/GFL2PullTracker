/** Recruitment families from EXILIUM-Tracker/i18n en/pages/pull.json,
 * revision da528b9296162d48dc15337f9250527be1a78803.
 * These are type names, not inferred names for individual pool IDs. */
const recruitmentNames: Record<number, string> = {
  1: 'Standard Procurement',
  3: 'Targeted Procurement',
  4: 'Military Upgrade',
  5: 'Beginner Procurement',
  6: 'Custom Procurement – Dolls',
  7: 'Custom Procurement – Weapons',
  8: 'Mystery Box'
};

export function recruitmentName(type: number): string {
  return recruitmentNames[type] ?? `Recruitment ${type}`;
}
