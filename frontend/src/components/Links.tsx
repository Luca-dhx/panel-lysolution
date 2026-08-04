/**
 * LIENS ET COORDONNÉES — une présentation, partout la même.
 *
 * ── CE QUI EXISTAIT ─────────────────────────────────────────────────────────
 * Des `<a>` nus. Bleus, soulignés, dessinés par le navigateur : le seul endroit
 * du Panel qui ne suivait pas le thème. Une adresse un peu longue débordait de
 * sa colonne sur mobile, et rien ne distinguait d'un coup d'œil un numéro de
 * téléphone d'une adresse électronique.
 *
 * ── LA FORME RETENUE ────────────────────────────────────────────────────────
 *
 *   [icône]  Libellé
 *            valeur, cliquable si elle mène quelque part
 *
 * L'icône ILLUSTRE, elle ne remplace pas le libellé : une pastille sans mot se
 * devine, et se devine mal. La valeur se tronque proprement plutôt que de
 * pousser la colonne — l'adresse complète reste dans l'infobulle et dans le
 * lien lui-même.
 *
 * Les liens externes portent tous `rel="noopener noreferrer"` : sans `noopener`
 * la page ouverte garde une prise sur celle qui l'a ouverte.
 */
import { Icon } from '@/components/Icon';
import type { IconName } from '@/components/Icon';

/** Ce qui suit un lien sortant, pour qu'on sache qu'on quitte le Panel. */
function MarqueExterne() {
  return <Icon name="box-arrow-up-right" size={12} className="link-external" />;
}

export function LinkRow({
  icon,
  label,
  value,
  href,
  external = false,
  title,
}: {
  icon: IconName;
  label: string;
  /** Ce qui s'affiche — souvent une version raccourcie de `href`. */
  value: string;
  href?: string | null;
  external?: boolean;
  title?: string;
}) {
  return (
    <div className="link-row">
      <span className="link-row-icon"><Icon name={icon} /></span>
      <span className="link-row-body">
        <span className="link-row-label">{label}</span>
        {href ? (
          <a
            className="link-action"
            href={href}
            title={title ?? value}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            <span className="link-action-value">{value}</span>
            {external ? <MarqueExterne /> : null}
          </a>
        ) : (
          <span className="link-row-value">{value}</span>
        )}
      </span>
    </div>
  );
}

/** Version compacte : une puce cliquable, quand la place manque. */
export function LinkChip({
  icon,
  children,
  href,
  external = false,
  title,
}: {
  icon: IconName;
  children: string;
  href: string;
  external?: boolean;
  title?: string;
}) {
  return (
    <a
      className="link-chip"
      href={href}
      title={title ?? children}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      <Icon name={icon} size={14} />
      <span className="link-chip-text">{children}</span>
      {external ? <MarqueExterne /> : null}
    </a>
  );
}

/** L'adresse sans son protocole : ce qu'on lit, jamais ce qu'on suit. */
export function sansProtocole(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}

/** Un numéro composable — les espaces de lecture ne se composent pas. */
export function lienTelephone(numero: string): string {
  return `tel:${numero.replace(/[^+0-9]/g, '')}`;
}
