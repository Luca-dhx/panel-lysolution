/**
 * Stratégies DNS d'une destination. Préserve la compatibilité des flux existants
 * (wildcard déjà en place, DNS manuel, fournisseur externe) tout en permettant
 * l'automatisation Hostinger.
 *
 *  - HOSTINGER_MANAGED : le moteur crée/ajuste les DNS via l'API Hostinger.
 *  - EXISTING_DNS      : le DNS existe déjà (wildcard/manuel) — on VÉRIFIE, sans muter.
 *  - MANUAL            : l'utilisateur gère le DNS lui-même (consignes de fallback).
 *  - NONE              : aucune gestion DNS (ex. tests).
 */
export const DNS_STRATEGIES = Object.freeze({
  HOSTINGER_MANAGED: 'HOSTINGER_MANAGED',
  EXISTING_DNS: 'EXISTING_DNS',
  MANUAL: 'MANUAL',
  NONE: 'NONE',
});

export const DNS_STRATEGY_VALUES = Object.values(DNS_STRATEGIES);

export default DNS_STRATEGIES;
