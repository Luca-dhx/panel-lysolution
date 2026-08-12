/**
 * LE JUSTIFICATIF D'UNE LIGNE — déposer, télécharger, remplacer, retirer.
 *
 * ══ IL N'Y A AUCUN LIEN ICI, ET C'EST LE POINT ══════════════════════════════
 *
 * Pas de `<a href>`, pas d'URL, pas même relative. Un document privé n'a pas
 * d'adresse : il se récupère par un appel authentifié, et le navigateur
 * enregistre le flux. Un lien, lui, finirait copié dans une conversation, où il
 * ne porterait plus aucune session — et le jour où quelqu'un l'ouvrirait sans
 * être connecté, il faudrait expliquer pourquoi il ne marche pas… ou pire,
 * pourquoi il marche.
 *
 * ══ LE FICHIER EST CHOISI PAR UN VRAI `<input type="file">` ═════════════════
 *
 * Masqué, déclenché par un bouton : on garde le sélecteur natif du système
 * — le seul qui donne accès au stockage du téléphone comme du poste — sans
 * hériter de son apparence, qui ne suit aucun thème.
 */
import { useRef, useState } from 'react';
import { errorMessage, finances } from '@/lib/api';
import { ACCEPTED_RECEIPT_MIMES } from '@/components/finance/financeLabels';
import type { FinancialTransaction } from '@/types.finance';

/** Poids lisible — « 1,2 Mo », jamais « 1258291 ». */
function poids(octets: number | null): string {
  if (!octets) return '';
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

export function ReceiptCell({
  transaction,
  onChanged,
  compact = false,
}: {
  transaction: FinancialTransaction;
  onChanged: () => Promise<void> | void;
  /** Dans un tableau, on montre l'essentiel ; dans le détail, tout. */
  compact?: boolean;
}) {
  const champ = useRef<HTMLInputElement>(null);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const piece = transaction.receipt;
  const supprime = transaction.deletedAt !== null;

  const agir = async (action: () => Promise<unknown>) => {
    setOccupe(true);
    setErreur(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setErreur(errorMessage(err, 'Opération impossible sur le justificatif.'));
    } finally {
      setOccupe(false);
    }
  };

  const choisir = (fichier: File | null | undefined) => {
    if (!fichier) return;
    void agir(() => finances.uploadReceipt(transaction.transactionId, fichier));
  };

  return (
    <div className="finance-receipt">
      <input
        ref={champ}
        type="file"
        className="sr-only"
        accept={ACCEPTED_RECEIPT_MIMES.join(',')}
        onChange={(e) => {
          choisir(e.target.files?.[0]);
          // On vide le champ : redéposer le MÊME fichier après un échec doit
          // redéclencher l'événement, ce qu'un `<input file>` ne fait pas si sa
          // valeur n'a pas changé.
          e.target.value = '';
        }}
      />

      {piece ? (
        <>
          <button
            type="button"
            className="btn btn-small"
            disabled={occupe}
            onClick={() => void agir(() => finances.downloadReceipt(
              transaction.transactionId,
              piece.filename ?? 'justificatif',
            ))}
          >
            Télécharger
          </button>
          {!compact ? (
            <span className="finance-receipt-name">
              {piece.filename}
              {piece.size ? <span className="muted"> · {poids(piece.size)}</span> : null}
            </span>
          ) : null}
          {!supprime ? (
            <>
              <button
                type="button"
                className="btn btn-small"
                disabled={occupe}
                onClick={() => champ.current?.click()}
              >
                Remplacer
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={occupe}
                onClick={() => void agir(() => finances.removeReceipt(transaction.transactionId))}
              >
                Retirer
              </button>
            </>
          ) : null}
        </>
      ) : (
        <>
          {supprime ? (
            <span className="muted">—</span>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              disabled={occupe}
              onClick={() => champ.current?.click()}
            >
              {occupe ? 'Envoi…' : 'Ajouter un justificatif'}
            </button>
          )}
        </>
      )}

      {erreur ? <span className="finance-receipt-error">{erreur}</span> : null}
    </div>
  );
}

export default ReceiptCell;
