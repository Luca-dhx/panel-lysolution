/**
 * LE KIT DES ÉCRANS REFONDUS — un seul point d'entrée.
 *
 * Un écran refondu importe d'ici, jamais des quatre librairies directement.
 * C'est ce qui garde la frontière lisible : le jour où une primitive change de
 * fournisseur — un `Skeleton` maison plutôt que celui de Radix — un seul
 * fichier bouge, et aucun écran ne s'en aperçoit.
 */
export { PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';

export { Metric, MetricRow } from './Metric';
export type { MetricProps } from './Metric';

export { Panel } from './Panel';
export type { PanelProps } from './Panel';

export {
  SkeletonLine, SkeletonRows, EmptyPanel, ErrorState, NoticeState,
} from './States';

export { PeriodPicker, PERIODES } from './PeriodPicker';
export type { PeriodOption } from './PeriodPicker';

export { SmoothTabs } from './SmoothTabs';
export type { SmoothTab } from './SmoothTabs';
