/**
 * LE FORMULAIRE D'UNE ENTREPRISE CLIENTE — une seule définition, deux usages.
 *
 * ══ POURQUOI IL VIT DANS UN COMPOSANT ═══════════════════════════════════════
 *
 * La création et la modification saisissent EXACTEMENT les mêmes champs. Les
 * écrire deux fois garantirait qu'un champ ajouté un jour n'apparaîtrait que
 * d'un côté — et le plus souvent du côté « création », le moins utilisé des
 * deux.
 *
 * ══ AUCUNE VALIDATION ICI, ET C'EST DÉLIBÉRÉ ════════════════════════════════
 *
 * Ni longueur de SIREN, ni clé de Luhn, ni cohérence SIRET ⊃ SIREN. Ces règles
 * vivent dans le backend (`clientCompany.validation.js`), qui est l'autorité :
 * les recopier ici produirait une seconde implémentation, et le jour où l'une
 * changerait, l'écran accepterait ce que le serveur refuse — ou l'inverse, ce
 * qui est pire : un opérateur bloqué par une règle que le serveur n'applique
 * plus.
 *
 * L'écran AIDE (types de champ, exemples, longueurs indicatives) ; il ne juge
 * pas. Le refus du serveur est affiché tel quel, et il nomme le champ.
 */
import type { ChangeEvent } from 'react';

import type { ClientAddress, ClientCompany } from '@/types.clientCompany';

export interface ClientCompanyFormValue {
  legalName: string;
  tradingName: string;
  legalForm: string;
  siren: string;
  siret: string;
  vatNumber: string;
  registrationCity: string;
  registeredOffice: {
    line1: string; line2: string; postalCode: string; city: string; country: string;
  };
  /**
   * `useBillingAddress` n'est PAS envoyé au serveur : c'est un état d'écran.
   *
   * Le modèle dit `billingAddress: null` ⇒ « la même que le siège ». Une case à
   * cocher exprime cela bien mieux qu'un second bloc d'adresse vide, que
   * l'opérateur remplirait « pour faire propre » — et les deux adresses
   * finiraient par diverger sans que personne ne l'ait décidé.
   */
  useBillingAddress: boolean;
  billingAddress: {
    line1: string; line2: string; postalCode: string; city: string; country: string;
  };
  billingEmail: string;
  phone: string;
  website: string;
  administrativeContact: { name: string; email: string; phone: string };
  contractualSigner: {
    firstName: string; lastName: string; jobTitle: string; email: string; phone: string;
  };
  notes: string;
}

const adresseVide = () => ({ line1: '', line2: '', postalCode: '', city: '', country: 'FR' });

export function formulaireVide(): ClientCompanyFormValue {
  return {
    legalName: '',
    tradingName: '',
    legalForm: '',
    siren: '',
    siret: '',
    vatNumber: '',
    registrationCity: '',
    registeredOffice: adresseVide(),
    useBillingAddress: false,
    billingAddress: adresseVide(),
    billingEmail: '',
    phone: '',
    website: '',
    administrativeContact: { name: '', email: '', phone: '' },
    contractualSigner: { firstName: '', lastName: '', jobTitle: '', email: '', phone: '' },
    notes: '',
  };
}

/**
 * Une fiche reçue du serveur, ramenée à la forme du formulaire.
 *
 * ══ POURQUOI LA SIGNATURE ATTEND `ClientCompany` ET NON UNE FORME LOCALE ════
 *
 * Une forme locale « assez proche » se serait mise à diverger au premier champ
 * ajouté — et la divergence se serait manifestée par un champ SILENCIEUSEMENT
 * absent du formulaire, donc effacé à l'enregistrement suivant. Le type du
 * domaine est la seule garantie que les deux restent d'accord.
 */
export function formulaireDepuis(fiche: ClientCompany): ClientCompanyFormValue {
  const adresse = (source: ClientAddress | null) => ({
    line1: source?.line1 ?? '',
    line2: source?.line2 ?? '',
    postalCode: source?.postalCode ?? '',
    city: source?.city ?? '',
    country: source?.country ?? 'FR',
  });
  const facturation = fiche.billingAddress;
  return {
    legalName: fiche.legalName,
    tradingName: fiche.tradingName ?? '',
    legalForm: fiche.legalForm ?? '',
    siren: fiche.siren ?? '',
    siret: fiche.siret ?? '',
    vatNumber: fiche.vatNumber ?? '',
    registrationCity: fiche.registrationCity ?? '',
    registeredOffice: adresse(fiche.registeredOffice),
    useBillingAddress: Boolean(facturation?.line1 || facturation?.city),
    billingAddress: adresse(facturation),
    billingEmail: fiche.billingEmail ?? '',
    phone: fiche.phone ?? '',
    website: fiche.website ?? '',
    administrativeContact: {
      name: fiche.administrativeContact?.name ?? '',
      email: fiche.administrativeContact?.email ?? '',
      phone: fiche.administrativeContact?.phone ?? '',
    },
    contractualSigner: {
      firstName: fiche.contractualSigner?.firstName ?? '',
      lastName: fiche.contractualSigner?.lastName ?? '',
      jobTitle: fiche.contractualSigner?.jobTitle ?? '',
      email: fiche.contractualSigner?.email ?? '',
      phone: fiche.contractualSigner?.phone ?? '',
    },
    notes: fiche.notes ?? '',
  };
}

/**
 * LE CORPS ENVOYÉ AU SERVEUR — la forme du formulaire, traduite.
 *
 * Deux traductions, et elles portent tout le sens :
 *
 *   `useBillingAddress: false`  ⇒  `billingAddress: null`, c'est-à-dire
 *                                  « la même que le siège » — jamais un objet
 *                                  vide, qui se lirait « adresse inconnue ».
 *   signataire entièrement vide ⇒  `contractualSigner: null`, c'est-à-dire
 *                                  « personne n'est désigné » — jamais une
 *                                  fiche de champs vides, qui passerait les
 *                                  contrôles de présence.
 */
export function corpsPour(v: ClientCompanyFormValue): Record<string, unknown> {
  const signataire = v.contractualSigner;
  const signataireRenseigne = Object.values(signataire).some((x) => String(x ?? '').trim() !== '');
  return {
    legalName: v.legalName,
    tradingName: v.tradingName,
    legalForm: v.legalForm,
    siren: v.siren,
    siret: v.siret,
    vatNumber: v.vatNumber,
    registrationCity: v.registrationCity,
    registeredOffice: v.registeredOffice,
    billingAddress: v.useBillingAddress ? v.billingAddress : null,
    billingEmail: v.billingEmail,
    phone: v.phone,
    website: v.website,
    administrativeContact: v.administrativeContact,
    contractualSigner: signataireRenseigne ? signataire : null,
    notes: v.notes,
  };
}

function Champ({
  label, value, onChange, hint, placeholder, type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  type?: string;
}) {
  const handler = (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className="input" type={type} value={value} onChange={handler} placeholder={placeholder} />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function BlocAdresse({
  titre,
  value,
  onChange,
}: {
  titre: string;
  value: ClientCompanyFormValue['registeredOffice'];
  onChange: (v: ClientCompanyFormValue['registeredOffice']) => void;
}) {
  const set = (cle: keyof typeof value) => (v: string) => onChange({ ...value, [cle]: v });
  return (
    <fieldset className="fieldset">
      <legend>{titre}</legend>
      <div className="form-grid">
        <Champ label="Voie" value={value.line1} onChange={set('line1')} placeholder="12 avenue des Lilas" />
        <Champ label="Complément" value={value.line2} onChange={set('line2')} placeholder="Bâtiment B" />
        <Champ label="Code postal" value={value.postalCode} onChange={set('postalCode')} placeholder="06000" />
        <Champ label="Ville" value={value.city} onChange={set('city')} placeholder="Nice" />
        <Champ
          label="Pays"
          value={value.country}
          onChange={set('country')}
          placeholder="FR"
          hint="Code ISO à deux lettres — c’est ce que le fournisseur de paiement exige."
        />
      </div>
    </fieldset>
  );
}

export function ClientCompanyForm({
  value,
  onChange,
}: {
  value: ClientCompanyFormValue;
  onChange: (v: ClientCompanyFormValue) => void;
}) {
  const set = <K extends keyof ClientCompanyFormValue>(cle: K) => (v: ClientCompanyFormValue[K]) =>
    onChange({ ...value, [cle]: v });

  return (
    <div className="form">
      <fieldset className="fieldset">
        <legend>Identité</legend>
        <div className="form-grid">
          <Champ
            label="Raison sociale *"
            value={value.legalName}
            onChange={set('legalName')}
            placeholder="SARL DUPONT AUTOMOBILES"
            hint="Ce qui figure sur la facture. Jamais l’enseigne."
          />
          <Champ
            label="Nom commercial"
            value={value.tradingName}
            onChange={set('tradingName')}
            placeholder="Auto Lilas"
            hint="L’enseigne, quand elle diffère de la raison sociale."
          />
          <Champ label="Forme juridique" value={value.legalForm} onChange={set('legalForm')} placeholder="SARL" />
          <Champ
            label="SIREN"
            value={value.siren}
            onChange={set('siren')}
            placeholder="732 829 320"
            hint="9 chiffres. Mention obligatoire de la facture électronique au 1er septembre 2026."
          />
          <Champ label="SIRET" value={value.siret} onChange={set('siret')} placeholder="732 829 320 00074" hint="14 chiffres, commençant par le SIREN." />
          <Champ label="N° de TVA" value={value.vatNumber} onChange={set('vatNumber')} placeholder="FR44732829320" />
          <Champ label="Ville d’immatriculation" value={value.registrationCity} onChange={set('registrationCity')} placeholder="Nice" />
        </div>
      </fieldset>

      <BlocAdresse titre="Siège social" value={value.registeredOffice} onChange={set('registeredOffice')} />

      <fieldset className="fieldset">
        <legend>Facturation</legend>
        <div className="form-grid">
          <Champ
            label="E-mail de facturation"
            type="email"
            value={value.billingEmail}
            onChange={set('billingEmail')}
            placeholder="comptabilite@exemple.fr"
            hint="C’est à cette adresse que la facture part."
          />
          <Champ label="Téléphone" value={value.phone} onChange={set('phone')} placeholder="+33 4 00 00 00 00" />
          <Champ label="Site web" value={value.website} onChange={set('website')} placeholder="https://exemple.fr" />
        </div>
        <label className="toolbar-check">
          <input
            type="checkbox"
            checked={value.useBillingAddress}
            onChange={(e) => onChange({ ...value, useBillingAddress: e.target.checked })}
          />
          L’adresse de facturation diffère du siège
        </label>
        {value.useBillingAddress ? (
          <BlocAdresse
            titre="Adresse de facturation"
            value={value.billingAddress}
            onChange={set('billingAddress')}
          />
        ) : null}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Signataire contractuel</legend>
        <p className="muted">
          La personne physique qui engage l’entreprise. Sans elle, aucune demande de signature ne
          peut être ouverte pour ses projets.
        </p>
        <div className="form-grid">
          <Champ
            label="Prénom"
            value={value.contractualSigner.firstName}
            onChange={(v) => onChange({ ...value, contractualSigner: { ...value.contractualSigner, firstName: v } })}
          />
          <Champ
            label="Nom"
            value={value.contractualSigner.lastName}
            onChange={(v) => onChange({ ...value, contractualSigner: { ...value.contractualSigner, lastName: v } })}
          />
          <Champ
            label="Fonction"
            value={value.contractualSigner.jobTitle}
            onChange={(v) => onChange({ ...value, contractualSigner: { ...value.contractualSigner, jobTitle: v } })}
            placeholder="Gérant"
          />
          <Champ
            label="E-mail"
            type="email"
            value={value.contractualSigner.email}
            onChange={(v) => onChange({ ...value, contractualSigner: { ...value.contractualSigner, email: v } })}
          />
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Contact administratif</legend>
        <div className="form-grid">
          <Champ
            label="Nom"
            value={value.administrativeContact.name}
            onChange={(v) => onChange({ ...value, administrativeContact: { ...value.administrativeContact, name: v } })}
          />
          <Champ
            label="E-mail"
            type="email"
            value={value.administrativeContact.email}
            onChange={(v) => onChange({ ...value, administrativeContact: { ...value.administrativeContact, email: v } })}
          />
          <Champ
            label="Téléphone"
            value={value.administrativeContact.phone}
            onChange={(v) => onChange({ ...value, administrativeContact: { ...value.administrativeContact, phone: v } })}
          />
        </div>
      </fieldset>

      <label className="field">
        <span className="field-label">Note interne</span>
        <textarea
          className="input"
          rows={3}
          value={value.notes}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          placeholder="Visible uniquement dans le Panel."
        />
        {/*
          LA NOTE NE QUITTE JAMAIS LE PANEL.
          Elle n'est pas publiée au projet et ne figure sur aucun document : le
          dire ici évite qu'on y écrive une information destinée au client — ou,
          pire, qu'on hésite à y écrire une appréciation qu'il ne doit pas lire.
        */}
        <span className="field-hint">
          Jamais publiée au projet, jamais imprimée sur une facture.
        </span>
      </label>
    </div>
  );
}

export default ClientCompanyForm;
