import { Router } from 'express';
import {
  health, livez, readyz, version,
} from '../controllers/meta.controller.js';

export const healthRouter = Router();
healthRouter.get('/', health);

/**
 * LES DEUX SONDES SONT SÉPARÉES, ET CE N'EST PAS UN DÉTAIL DE FORME.
 *
 * `/livez` répond « ce process vit » — il ne doit JAMAIS échouer pour une
 * dépendance externe, sous peine de faire redémarrer un backend sain.
 * `/readyz` répond « je peux traiter du métier » — il DOIT échouer dès qu'une
 * dépendance indispensable manque, sous peine de laisser router du trafic vers
 * un service qui ne peut pas le servir.
 *
 * Les fondre en un seul `/health` — ce que faisait le Panel — revient à choisir
 * l'un des deux comportements pour les deux usages. C'est exactement ce qui
 * rendait un `/health` à 200 compatible avec une base déconnectée.
 */
export const livezRouter = Router();
livezRouter.get('/', livez);

export const readyzRouter = Router();
readyzRouter.get('/', readyz);

export const versionRouter = Router();
versionRouter.get('/', version);
