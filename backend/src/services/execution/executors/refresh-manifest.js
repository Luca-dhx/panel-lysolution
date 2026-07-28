// EXÉCUTEUR — REFRESH_MANIFEST.
//
// Relit le Manifest officiel publié par le projet (GET /manifest, contrat
// >= 1.1.0) et met à jour le registre du Panel.
//
// C'est la PREMIÈRE action du registre qui écrit — et elle n'écrit que dans
// la base du PANEL, jamais chez le projet. La distinction est essentielle :
// piloter, ce n'est pas encore modifier le projet.
import { PHASE } from '../execution-log.service.js';

export const id = 'refresh-manifest';

export function simulate({ record, log }) {
  log.info(PHASE.STEP, 'Simulation : le Manifest ne sera ni lu ni écrit.');
  return {
    plan: [
      { step: 'fetch', description: 'Appeler GET /api/project-bridge/v1/manifest' },
      { step: 'validate', description: 'Valider le Manifest contre le schéma officiel' },
      { step: 'store', description: 'Enregistrer le Manifest dans le registre du Panel (source BRIDGE)' },
    ],
    summary: `Relirait le Manifest de ${record?.projectName} et mettrait à jour le registre du Panel.`,
  };
}

export async function execute({ record, client, log, services }) {
  log.info(PHASE.STEP, 'Lecture du Manifest publié par le projet…');
  const manifest = await client.getManifest();

  log.info(PHASE.STEP, 'Validation contre le schéma officiel…');
  const validation = services.validateManifest(manifest);
  if (!validation.valid) {
    const detail = validation.errors.map((e) => `${e.path}: ${e.message}`).join(' · ');
    throw new Error(`Manifest non conforme au schéma officiel : ${detail}`);
  }
  if (validation.manifest.project.key !== record.projectKey) {
    throw new Error(
      `Le Manifest déclare project.key « ${validation.manifest.project.key} » alors que la fiche est « ${record.projectKey} ».`,
    );
  }

  log.info(PHASE.STEP, 'Enregistrement dans le registre du Panel.');
  await services.setManifestFromBridge(record, validation.manifest);

  return {
    result: {
      manifestVersion: validation.manifest.manifestVersion,
      unknownFeatures: validation.unknownFeatures,
    },
    summary: `Manifest ${validation.manifest.manifestVersion} enregistré (source : pont).`,
  };
}

export default { id, simulate, execute };
