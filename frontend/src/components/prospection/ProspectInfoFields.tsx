/**
 * LES CHAMPS D'INFORMATION LIBRES D'UN PROSPECT.
 *
 * ══ DEUX MODES, ET UN SEUL COMPOSANT ════════════════════════════════════════
 *
 * En LECTURE, c'est une liste de définitions : l'étiquette au-dessus, la valeur
 * en dessous, en deux colonnes dès qu'il y a la place. Un tableau à deux
 * colonnes aurait été plus « propre » et illisible sous 500 px, où chaque
 * cellule se serait réduite à trois caractères.
 *
 * En ÉDITION, une ligne par champ, plus un bouton pour en ajouter. L'ordre est
 * celui du tableau : les flèches échangent deux voisins, et l'ordre affiché est
 * celui qu'on a posé.
 *
 * ══ POURQUOI ON N'IMPOSE PAS DE VALEUR ═════════════════════════════════════
 *
 * On crée souvent l'étiquette avant d'avoir la réponse — « budget annoncé » est
 * une question qu'on se pose avant l'appel. Un champ sans NOM, en revanche, n'a
 * aucun sens pour celui qui relit : c'est le seul des deux qui soit exigé.
 */
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Icon } from '@/components/Icon';
import type { ProspectInfoField } from '@/types.prospection';

const identifiant = () => (
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `if-${Math.random().toString(36).slice(2)}`
);

export function ProspectInfoFieldsView({ fields }: { fields: ProspectInfoField[] }) {
  if (!fields.length) {
    return (
      <p className="text-sm text-tertiary">
        Aucune information libre. « Modifier la fiche » permet d’en ajouter
        autant qu’on veut — budget annoncé, hébergeur actuel, qui décide.
      </p>
    );
  }

  return (
    <dl className="uui grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {fields.map((champ) => (
        <div key={champ.id} className="min-w-0">
          <dt className="text-xs font-semibold tracking-wide text-tertiary uppercase">
            {champ.label}
          </dt>
          {/* `whitespace-pre-wrap` : on colle parfois une adresse sur trois
              lignes, et la réduire à une seule la rend incopiable. */}
          <dd className="mt-0.5 text-sm whitespace-pre-wrap text-secondary">
            {champ.value.trim() || <span className="text-quaternary">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ProspectInfoFieldsEditor({
  fields, onChange,
}: {
  fields: ProspectInfoField[];
  onChange: (fields: ProspectInfoField[]) => void;
}) {
  const modifier = (id: string, champ: 'label' | 'value', valeur: string) => {
    onChange(fields.map((f) => (f.id === id ? { ...f, [champ]: valeur } : f)));
  };

  const deplacer = (index: number, sens: -1 | 1) => {
    const cible = index + sens;
    if (cible < 0 || cible >= fields.length) return;
    const copie = [...fields];
    [copie[index], copie[cible]] = [copie[cible], copie[index]];
    onChange(copie);
  };

  return (
    <div className="uui flex flex-col gap-2">
      {fields.length === 0 ? (
        <p className="text-xs text-tertiary">
          Aucune information libre pour l’instant.
        </p>
      ) : null}

      {fields.map((champ, index) => (
        <div key={champ.id} className="flex items-start gap-2 rounded-lg border border-secondary p-3">
          <div className="grid flex-1 gap-2 sm:grid-cols-2">
            <Input
              size="sm"
              aria-label={`Nom de l’information ${index + 1}`}
              placeholder="Nom — ex. « Budget annoncé »"
              value={champ.label}
              onChange={(v) => modifier(champ.id, 'label', v)}
            />
            <Input
              size="sm"
              aria-label={`Contenu de l’information ${index + 1}`}
              placeholder="Contenu"
              value={champ.value}
              onChange={(v) => modifier(champ.id, 'value', v)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Button
              size="sm" color="tertiary" className="size-8"
              aria-label={`Monter l’information ${index + 1}`}
              isDisabled={index === 0}
              onClick={() => deplacer(index, -1)}
            >
              <Icon name="chevron-down" className="rotate-180" />
            </Button>
            <Button
              size="sm" color="tertiary" className="size-8"
              aria-label={`Descendre l’information ${index + 1}`}
              isDisabled={index === fields.length - 1}
              onClick={() => deplacer(index, 1)}
            >
              <Icon name="chevron-down" />
            </Button>
            <Button
              size="sm" color="link-destructive" className="size-8"
              aria-label={`Supprimer l’information ${index + 1}`}
              onClick={() => onChange(fields.filter((f) => f.id !== champ.id))}
            >
              <Icon name="trash" />
            </Button>
          </div>
        </div>
      ))}

      <div>
        <Button
          size="sm"
          color="secondary"
          iconLeading={() => <Icon name="plus-lg" />}
          onClick={() => onChange([...fields, { id: identifiant(), label: '', value: '' }])}
        >
          Ajouter une information
        </Button>
      </div>
    </div>
  );
}

export default ProspectInfoFieldsView;
