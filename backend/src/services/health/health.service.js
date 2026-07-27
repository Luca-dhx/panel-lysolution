// Santé et version du Panel lui-même — le Panel est un projet standard et
// expose les mêmes points que les projets (/health, /api/version).
import { createRequire } from 'node:module';
import config from '../../config/env.js';
import { CONTRACT_VERSION, nowIso } from '../../bridge/bridgeContract.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json');

export function buildHealth() {
  return { status: 'ok', service: 'panel-backend', time: nowIso() };
}

export function buildVersion() {
  return {
    name: config.panelName,
    softwareVersion: pkg.version,
    contractVersion: CONTRACT_VERSION,
    environment: config.env,
  };
}
