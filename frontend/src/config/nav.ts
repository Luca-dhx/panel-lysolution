export interface NavItem {
  to: string;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/projects', label: 'Projets' },
  { to: '/bridges', label: 'Bridges' },
  { to: '/versions', label: 'Versions' },
  { to: '/pairings', label: 'Appairages' },
];
