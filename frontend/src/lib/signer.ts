import type { CompanySigner } from '@/types.company';

/**
 * Règles de complétude d'un signataire contractuel.
 *
 * MIROIR de `manager/src/lib/signer.ts` et de `backend/src/utils/signer.js` du
 * projet : le backend du PROJET reste l'autorité — c'est lui qui refuse la
 * validation d'un contrat. Ces règles ne servent qu'à donner un retour
 * immédiat pendant la saisie. Toute évolution doit être répercutée partout,
 * sans quoi le Panel annoncerait « complet » sur un signataire qu'un projet
 * refusera.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignerField = keyof CompanySigner;

/** `jobTitle` est absent : la fonction ne conditionne pas la capacité à signer. */
export const SIGNER_REQUIRED_FIELDS: SignerField[] = ['firstName', 'lastName', 'email'];

export const EMPTY_SIGNER: CompanySigner = { firstName: '', lastName: '', jobTitle: '', email: '' };

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test((email || '').trim());
}

/** Champs requis manquants ou invalides. */
export function getSignerGaps(signer: CompanySigner | null): SignerField[] {
  if (!signer) return [...SIGNER_REQUIRED_FIELDS];
  const gaps: SignerField[] = [];
  for (const field of SIGNER_REQUIRED_FIELDS) {
    const value = (signer[field] || '').trim();
    if (!value) gaps.push(field);
    else if (field === 'email' && !isValidEmail(value)) gaps.push(field);
  }
  return gaps;
}

export function isSignerComplete(signer: CompanySigner | null): boolean {
  return getSignerGaps(signer).length === 0;
}

/** Un signataire « vierge » compte comme non configuré, pas comme incomplet. */
export function isSignerEmpty(signer: CompanySigner | null): boolean {
  if (!signer) return true;
  return !SIGNER_REQUIRED_FIELDS.some((f) => (signer[f] || '').trim())
    && !(signer.jobTitle || '').trim();
}
