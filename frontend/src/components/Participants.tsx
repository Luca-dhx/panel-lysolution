/**
 * PARTICIPANTS — une liste d'items, plus jamais un champ à virgules.
 *
 * ── CE QUI EXISTAIT, ET POURQUOI C'ÉTAIT UN PIÈGE ───────────────────────────
 * Un `<input>` unique, avec pour seule consigne « séparés par des virgules ».
 * Le séparateur n'existait que dans la tête de celui qui saisissait : personne
 * ne savait si « Jean Dupont, Garage du centre » désignait une personne ou
 * deux. Corriger une adresse obligeait à relire toute la ligne, retirer
 * quelqu'un revenait à couper au bon endroit sans se tromper, et un numéro de
 * téléphone n'avait nulle part où être écrit.
 *
 * ── CE QUE C'EST DEVENU ─────────────────────────────────────────────────────
 * Une liste : on AJOUTE par un bouton, on MODIFIE un champ à la fois, on
 * SUPPRIME une ligne sans toucher aux autres. Chaque personne porte un
 * identifiant — c'est lui, et non sa position, qui la désigne : sans cela une
 * suppression décalerait tout ce qui suit.
 *
 * ── INTERNES : POURQUOI PAS UNE LISTE DÉROULANTE DE COMPTES ─────────────────
 * Le Panel n'expose AUCUNE liste de ses comptes : le service d'utilisateurs
 * sait authentifier et retrouver une personne par son identifiant, rien de
 * plus, et la seule route qui parle d'utilisateur (`/api/auth/me`) ne renvoie
 * que le compte connecté. Proposer une sélection demanderait donc d'inventer
 * une API — hors sujet pour ce lot, et une surface d'exposition de plus.
 * La saisie reste donc libre, mais STRUCTURÉE : nom, courriel, téléphone.
 * Le jour où une liste de comptes existera, seul ce composant changera.
 *
 * ── AUCUN ITEM VIDE ─────────────────────────────────────────────────────────
 * Une ligne ouverte puis abandonnée n'est jamais envoyée : `participantsPrets`
 * la retire avant l'appel. Le serveur applique la même règle de son côté — une
 * garantie de formulaire ne protège que les gens qui passent par le formulaire.
 */
import type { Participant, ParticipantType } from '@/types.events';

/** Identifiant local : le serveur garde celui qu'il reçoit, ou en pose un. */
function nouvelId(): string {
  const natif = globalThis.crypto?.randomUUID?.();
  return natif ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nouveauParticipant(type: ParticipantType = 'EXTERNAL'): Participant {
  return { id: nouvelId(), type, name: '', email: '', phone: '' };
}

/**
 * Ce qui part réellement au serveur : les lignes vides disparaissent, les
 * champs facultatifs restés vides ne sont pas envoyés.
 */
export function participantsPrets(participants: Participant[]): Participant[] {
  return participants
    .map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name.trim(),
      email: p.email?.trim() ?? '',
      phone: p.phone?.trim() ?? '',
    }))
    .filter((p) => p.name || p.email || p.phone)
    .map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name || p.email || p.phone,
      ...(p.email ? { email: p.email } : {}),
      ...(p.phone ? { phone: p.phone } : {}),
    }));
}

const TYPE_LABEL: Record<ParticipantType, string> = {
  INTERNAL: 'De l’équipe',
  EXTERNAL: 'Côté client',
};

function LigneParticipant({
  participant,
  onChange,
  onRemove,
}: {
  participant: Participant;
  onChange: (p: Participant) => void;
  onRemove: () => void;
}) {
  const modifier = (champ: keyof Participant, valeur: string) =>
    onChange({ ...participant, [champ]: valeur });

  const nomLisible = participant.name.trim() || 'ce participant';

  return (
    <li className="participant">
      <div className="participant-head">
        <div className="segmented" role="group" aria-label="Qui est cette personne ?">
          {(['INTERNAL', 'EXTERNAL'] as ParticipantType[]).map((t) => (
            <button
              key={t}
              type="button"
              className={participant.type === t ? 'segment segment-active' : 'segment'}
              aria-pressed={participant.type === t}
              onClick={() => modifier('type', t)}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          aria-label={`Retirer ${nomLisible}`}
          onClick={onRemove}
        >
          Retirer
        </button>
      </div>

      <label className="field">
        <span className="field-label">Nom</span>
        <input
          type="text"
          value={participant.name}
          onChange={(e) => modifier('name', e.target.value)}
          placeholder="Jean Dupont"
        />
      </label>
      <label className="field">
        <span className="field-label">Courriel <span className="muted">(facultatif)</span></span>
        <input
          type="email"
          value={participant.email ?? ''}
          onChange={(e) => modifier('email', e.target.value)}
          placeholder="jean.dupont@exemple.fr"
        />
      </label>
      <label className="field">
        <span className="field-label">Téléphone <span className="muted">(facultatif)</span></span>
        <input
          type="tel"
          value={participant.phone ?? ''}
          onChange={(e) => modifier('phone', e.target.value)}
          placeholder="06 12 34 56 78"
        />
      </label>
    </li>
  );
}

/** L'éditeur : ajouter, modifier, supprimer — trois gestes, trois boutons. */
export function ParticipantsField({
  participants,
  onChange,
  hint,
}: {
  participants: Participant[];
  onChange: (participants: Participant[]) => void;
  hint?: string;
}) {
  const ajouter = () => onChange([...participants, nouveauParticipant()]);
  const remplacer = (id: string, remplacant: Participant) =>
    onChange(participants.map((p) => (p.id === id ? remplacant : p)));
  const retirer = (id: string) => onChange(participants.filter((p) => p.id !== id));

  return (
    <div className="field participants-field">
      <span className="field-label">Participants</span>
      {participants.length === 0 ? (
        <p className="muted">{hint ?? 'Personne pour l’instant.'}</p>
      ) : (
        <ul className="participants">
          {participants.map((p) => (
            <LigneParticipant
              key={p.id}
              participant={p}
              onChange={(remplacant) => remplacer(p.id, remplacant)}
              onRemove={() => retirer(p.id)}
            />
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="btn btn-secondary btn-small" onClick={ajouter}>
          Ajouter un participant
        </button>
      </div>
    </div>
  );
}

/**
 * L'AFFICHAGE — une pastille par personne, jamais une phrase à séparateurs.
 *
 * Recoller les noms avec des virgules à la lecture reproduirait exactement
 * l'ambiguïté qu'on vient de supprimer : « Jean Dupont, Marie » se relit comme
 * une seule chaîne. Une pastille par personne dit combien elles sont.
 */
export function ParticipantsSummary({ participants }: { participants: Participant[] }) {
  if (!participants || participants.length === 0) return null;
  return (
    <span className="badge-list">
      {participants.map((p) => (
        <span
          key={p.id}
          className={p.type === 'INTERNAL' ? 'badge badge-neutral' : 'badge badge-muted'}
          title={[p.email, p.phone].filter(Boolean).join(' · ') || undefined}
        >
          {p.name}
        </span>
      ))}
    </span>
  );
}
