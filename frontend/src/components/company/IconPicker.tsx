/**
 * CHOISIR UNE ICÔNE — en la voyant, pas en la nommant.
 *
 * ── CE QUI EXISTAIT AVANT ───────────────────────────────────────────────────
 * Un champ texte, avec « bi-star » pour seule indication. Il fallait connaître
 * par cœur la nomenclature d'un jeu de deux mille glyphes, ou aller la chercher
 * ailleurs, pour saisir une chaîne dont rien ne vérifiait l'existence. Une
 * faute de frappe donnait un carré vide sur la page Support d'un client, sans
 * le moindre signal côté Panel.
 *
 * Ici l'icône se choisit dans une grille : on la voit avant de la retenir, et
 * ce qu'on retient existe forcément.
 *
 * ── LE CHAMP LIBRE EXISTE, MAIS PAS DANS LE CHEMIN NORMAL ───────────────────
 * N'importe quel nom `bi-*` valide reste saisissable : fermer cette porte
 * obligerait à livrer une version du Panel pour ajouter une icône.
 *
 * Mais elle est REPLIÉE. Laissée ouverte à côté de la grille, elle réintroduit
 * exactement ce qu'on venait de supprimer : un champ où l'on tape un slug de
 * mémoire. On choisit dans la grille ; on déplie « nom exact » seulement quand
 * on sait précisément ce qu'on cherche.
 *
 * ── L'APERÇU EST LA VÉRIFICATION ────────────────────────────────────────────
 * Le nom saisi est rendu en direct à côté du champ. Un nom inconnu n'affiche
 * rien — et cette absence est le signal, immédiatement, au lieu d'être
 * découverte en production.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOGUE_ICONES, chercherIcones } from './referenceIcons';

export function IconPicker({
  value,
  onChange,
  label = 'Icône',
}: {
  value: string;
  onChange: (nom: string) => void;
  label?: string;
}) {
  const [ouvert, setOuvert] = useState(false);
  const [requete, setRequete] = useState('');
  const [avance, setAvance] = useState(false);
  const conteneur = useRef<HTMLDivElement | null>(null);

  /**
   * Un clic à l'extérieur referme — c'est ce qu'on attend d'un sélecteur.
   * Sans cela il faudrait viser le bouton pour s'en débarrasser, y compris
   * après avoir choisi.
   */
  useEffect(() => {
    if (!ouvert) return undefined;
    const dehors = (e: MouseEvent) => {
      if (conteneur.current && !conteneur.current.contains(e.target as Node)) setOuvert(false);
    };
    const echap = (e: KeyboardEvent) => { if (e.key === 'Escape') setOuvert(false); };
    document.addEventListener('mousedown', dehors);
    document.addEventListener('keydown', echap);
    return () => {
      document.removeEventListener('mousedown', dehors);
      document.removeEventListener('keydown', echap);
    };
  }, [ouvert]);

  const resultats = useMemo(() => chercherIcones(requete), [requete]);
  const total = useMemo(
    () => resultats.reduce((n, c) => n + c.icones.length, 0),
    [resultats],
  );

  const choisir = (nom: string) => {
    onChange(nom);
    setOuvert(false);
    setRequete('');
    // Rouvrir doit repartir du parcours normal, pas du dernier écart.
    setAvance(false);
  };

  return (
    <div className="icon-picker" ref={conteneur}>
      <button
        type="button"
        className="icon-picker-trigger"
        onClick={() => setOuvert((o) => !o)}
        aria-expanded={ouvert}
        aria-label={`${label} : ${value || 'aucune'}`}
        title={value || label}
      >
        {/* L'aperçu du choix courant. Vide si le nom n'existe pas — le signal. */}
        <i className={`bi ${value}`} aria-hidden />
      </button>

      {ouvert ? (
        <div className="icon-picker-panel" role="dialog" aria-label={label}>
          <input
            type="text"
            className="icon-picker-search"
            placeholder="Rechercher (téléphone, adresse, linkedin…)"
            value={requete}
            onChange={(e) => setRequete(e.target.value)}
            autoFocus
          />

          <div className="icon-picker-grid-wrap">
            {total === 0 ? (
              <p className="muted icon-picker-empty">
                Aucune icône ne correspond. Dépliez « Saisir un nom exact » si vous connaissez le nom.
              </p>
            ) : (
              resultats.map((categorie) => (
                <section key={categorie.titre} className="icon-picker-cat">
                  <h4>{categorie.titre}</h4>
                  <div className="icon-picker-grid">
                    {categorie.icones.map((icone) => (
                      <button
                        key={icone.nom}
                        type="button"
                        className={`icon-picker-cell${icone.nom === value ? ' is-selected' : ''}`}
                        onClick={() => choisir(icone.nom)}
                        title={icone.nom}
                        aria-label={icone.nom}
                        aria-pressed={icone.nom === value}
                      >
                        <i className={`bi ${icone.nom}`} aria-hidden />
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>

          {/* LA PORTE DE SORTIE — repliée. Voir l'en-tête : la laisser ouverte
              réintroduirait le champ de slug qu'on vient de supprimer. */}
          <div className="icon-picker-manual">
            <button
              type="button"
              className="icon-picker-advanced-toggle"
              aria-expanded={avance}
              onClick={() => setAvance((a) => !a)}
            >
              {avance ? 'Masquer le nom exact' : 'Saisir un nom exact'}
            </button>

            {avance ? (
              <label className="field">
                <span className="field-label">Nom Bootstrap Icons</span>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => onChange(e.target.value.trim())}
                  placeholder="bi-star"
                />
                <span className="field-hint muted">
                  {CATALOGUE_ICONES.length} familles proposées ci-dessus ; tout nom valide du jeu officiel est accepté.
                </span>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
