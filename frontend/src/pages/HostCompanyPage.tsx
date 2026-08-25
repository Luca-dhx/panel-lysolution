import { useCallback, useEffect, useState } from 'react';

import { Card, EmptyState } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/ToastProvider';
import { errorMessage } from '@/lib/api';
import { legalApi } from '@/lib/legalApi';
import type { HostCompany, HostCompanyScreen } from '@/types.legal';

/**
 * ENTREPRISE HÉBERGEUSE — une fiche de DONNÉES, pas un paragraphe.
 *
 * ══ CE QUE CET ÉCRAN N'EST PAS ════════════════════════════════════════════
 *
 * Ce n'est pas un champ « Hébergeur » où l'on tape « Hostinger, Chypre ». La
 * mention légale d'hébergement exige une dénomination exacte, une adresse et
 * un moyen de contact ; les stocker en chaîne libre les rend impossibles à
 * réutiliser, à comparer et à vérifier — et surtout impossibles à corriger
 * partout à la fois le jour d'une migration.
 *
 * ══ POURQUOI `source` ET `verifiedAt` SONT DES CHAMPS ═════════════════════
 *
 * Parce qu'une identité juridique recopiée d'un site tiers devient, en six
 * mois, une valeur que plus personne n'ose toucher : on ne sait plus d'où elle
 * vient, donc on ne peut ni la confirmer ni la corriger. Ces deux champs sont
 * ce qui rend la revérification possible — et ils ne sont JAMAIS publiés à un
 * projet : ce sont des données d'exploitation, pas du contenu.
 *
 * ══ ENREGISTRER REPUBLIE TOUT LE PARC ═════════════════════════════════════
 *
 * L'hébergeur figure sur les mentions légales de chaque site. Le backend
 * republie donc les documents des projets qui en ont — sans redéploiement.
 * L'écran le dit, parce qu'un enregistrement qui touche tous les clients ne
 * doit pas ressembler à un enregistrement local.
 */

const EMPTY: Omit<HostCompany, 'hostCompanyId' | 'status' | 'createdAt' | 'updatedAt' | 'updatedBy'> = {
  legalName: '',
  tradingName: null,
  legalForm: null,
  registrationNumber: null,
  address: { line1: null, line2: null, postalCode: null, city: null, country: null, countryCode: null },
  email: null,
  phone: null,
  website: null,
  source: null,
  verifiedAt: null,
  notes: null,
};

export function HostCompanyPage() {
  const toast = useToast();
  const [screen, setScreen] = useState<HostCompanyScreen | null>(null);
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await legalApi.hosts();
      setScreen(res);
    } catch (err) {
      toast.error(errorMessage(err, 'Lecture impossible.'));
    }
  }, [toast]);

  useEffect(() => { void reload(); }, [reload]);

  const openEdit = (host: HostCompany) => {
    setEditingId(host.hostCompanyId);
    setForm({
      legalName: host.legalName,
      tradingName: host.tradingName,
      legalForm: host.legalForm,
      registrationNumber: host.registrationNumber,
      address: { ...host.address },
      email: host.email,
      phone: host.phone,
      website: host.website,
      source: host.source,
      verifiedAt: host.verifiedAt,
      notes: host.notes,
    });
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      if (editingId) await legalApi.updateHost(editingId, form as unknown as Record<string, unknown>);
      else await legalApi.createHost(form as unknown as Record<string, unknown>);
      setForm(null);
      setEditingId(null);
      await reload();
      toast.success(
        'Fiche enregistrée. Les mentions légales des projets concernés ont été republiées — '
        + 'aucun redéploiement n’est nécessaire.',
      );
    } catch (err) {
      toast.error(errorMessage(err, 'Enregistrement impossible.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (host: HostCompany) => {
    try {
      await legalApi.setHostStatus(host.hostCompanyId, host.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE');
      await reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Opération impossible.'));
    }
  };

  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setAddress = (patch: Partial<typeof EMPTY['address']>) =>
    setForm((f) => (f ? { ...f, address: { ...f.address, ...patch } } : f));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Entreprise hébergeuse</h1>
        <p className="page-description">
          L’identité de l’hébergeur citée par les mentions légales de chaque site du parc. Ce sont
          des données réutilisables — pas un texte de mentions légales.
        </p>
      </header>

      {screen === null && <p className="muted">Chargement…</p>}

      {screen && screen.hosts.length === 0 && !form && (
        <EmptyState
          title="Aucun hébergeur enregistré"
          hint="Ajoutez la fiche de l’hébergeur : elle alimentera la section « Hébergement » des mentions légales."
        />
      )}

      {screen?.hosts.map((host) => (
        <Card
          key={host.hostCompanyId}
          title={host.legalName}
          className={host.status === 'ARCHIVED' ? 'legal-host is-archived' : 'legal-host'}
        >
          <div className="legal-host-head">
            <span className={`badge ${host.status === 'ACTIVE' ? 'badge-ok' : 'badge-muted'}`}>
              {host.status === 'ACTIVE' ? 'Actif' : 'Archivé'}
            </span>
            {screen.active?.hostCompanyId === host.hostCompanyId && (
              <span className="legal-chip">cité par les documents légaux</span>
            )}
          </div>

          <dl className="legal-host-facts">
            <Fact label="Nom d’usage" value={host.tradingName} />
            <Fact label="Forme juridique" value={host.legalForm} />
            <Fact label="Immatriculation" value={host.registrationNumber} />
            <Fact label="Adresse" value={formatAddress(host)} />
            <Fact label="E-mail" value={host.email} />
            <Fact label="Téléphone" value={host.phone} />
            <Fact label="Site web" value={host.website} />
            <Fact label="Dernière vérification" value={host.verifiedAt} />
            <Fact label="Source" value={host.source} wide />
            <Fact label="Notes internes" value={host.notes} wide />
          </dl>

          <div className="legal-host-actions">
            <button type="button" className="btn btn-small" onClick={() => openEdit(host)}>
              <Icon name="pencil" /> Modifier
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => void toggleStatus(host)}>
              <Icon name="archive" /> {host.status === 'ACTIVE' ? 'Archiver' : 'Réactiver'}
            </button>
          </div>
        </Card>
      ))}

      {!form && (
        <button
          type="button"
          className="btn"
          onClick={() => { setEditingId(null); setForm({ ...EMPTY, address: { ...EMPTY.address } }); }}
        >
          <Icon name="plus-lg" /> Ajouter un hébergeur
        </button>
      )}

      {form && (
        <Card title={editingId ? 'Modifier la fiche' : 'Nouvel hébergeur'}>
          <div className="legal-host-form">
            <Field label="Raison sociale" required value={form.legalName} onChange={(v) => set({ legalName: v })} />
            <Field label="Nom d’usage" value={form.tradingName} onChange={(v) => set({ tradingName: v })} />
            <Field label="Forme juridique" value={form.legalForm} onChange={(v) => set({ legalForm: v })} />
            <Field
              label="Numéro d’immatriculation"
              hint="L’identifiant au registre du pays de l’hébergeur — pas nécessairement un SIREN."
              value={form.registrationNumber}
              onChange={(v) => set({ registrationNumber: v })}
            />
            <Field label="Adresse" value={form.address.line1} onChange={(v) => setAddress({ line1: v })} />
            <Field label="Complément" value={form.address.line2} onChange={(v) => setAddress({ line2: v })} />
            <Field label="Code postal" value={form.address.postalCode} onChange={(v) => setAddress({ postalCode: v })} />
            <Field label="Ville" value={form.address.city} onChange={(v) => setAddress({ city: v })} />
            <Field label="Pays" value={form.address.country} onChange={(v) => setAddress({ country: v })} />
            <Field label="Code pays (ISO)" value={form.address.countryCode} onChange={(v) => setAddress({ countryCode: v })} />
            <Field label="E-mail" value={form.email} onChange={(v) => set({ email: v })} />
            <Field label="Téléphone" value={form.phone} onChange={(v) => set({ phone: v })} />
            <Field label="Site web" value={form.website} onChange={(v) => set({ website: v })} />
            <Field
              label="Date de dernière vérification"
              hint="Quand ces données ont-elles été contrôlées à la source ? Jamais déduite de l’enregistrement."
              value={form.verifiedAt}
              onChange={(v) => set({ verifiedAt: v })}
            />
            <Field
              label="Source"
              wide
              hint="L’adresse des pages officielles qui font foi. Sans elle, personne ne pourra revérifier."
              value={form.source}
              onChange={(v) => set({ source: v })}
            />
            <Field label="Notes internes" wide value={form.notes} onChange={(v) => set({ notes: v })} />
          </div>

          <p className="alert alert-info">
            <Icon name="shield-check" /> Enregistrer republie les documents légaux de tous les projets
            concernés. Les sites affichent la nouvelle valeur sans redéploiement.
          </p>

          <div className="legal-host-actions">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              Enregistrer
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setForm(null); setEditingId(null); }}>
              Annuler
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Fact({ label, value, wide = false }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={wide ? 'legal-host-fact is-wide' : 'legal-host-fact'}>
      <dt>{label}</dt>
      <dd>{value || <span className="muted">non renseigné</span>}</dd>
    </div>
  );
}

function Field({
  label, value, onChange, required = false, hint, wide = false,
}: {
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  required?: boolean;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'field is-wide' : 'field'}>
      <label className="field-label">
        {label}{required && <span className="field-required"> *</span>}
      </label>
      <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="muted field-hint">{hint}</p>}
    </div>
  );
}

function formatAddress(host: HostCompany): string | null {
  const parts = [
    host.address.line1,
    host.address.line2,
    [host.address.postalCode, host.address.city].filter(Boolean).join(' ') || null,
    host.address.country,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export default HostCompanyPage;
