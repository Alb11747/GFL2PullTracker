export const trackerPages = [
  { slug: 'history', label: 'My history', title: 'Recruitment ledger' },
  { slug: 'backup', label: 'Backup & sync', title: 'Backup & sync' },
  { slug: 'profiles', label: 'Profiles', title: 'Profiles' },
  { slug: 'statistics', label: 'Community statistics', title: 'Community statistics' },
  { slug: 'privacy', label: 'Privacy', title: 'Privacy & recovery' },
  { slug: 'about', label: 'About', title: 'About' }
] as const;

export type TrackerSection = (typeof trackerPages)[number]['slug'];

export function isTrackerSection(value: string): value is TrackerSection {
  return trackerPages.some((page) => page.slug === value);
}
