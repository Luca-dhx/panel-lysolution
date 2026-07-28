export interface NavItem {
  to: string;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Supervision' },
  { to: '/supervision', label: 'Parc' },
  { to: '/actions', label: 'Actions' },
  { to: '/projects', label: 'Projets' },
  { to: '/bridges', label: 'Bridges' },
  { to: '/versions', label: 'Versions' },
  { to: '/pairings', label: 'Appairages' },
  { to: '/panel', label: 'Panel' },
];
