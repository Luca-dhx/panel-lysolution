import { Router } from 'express';
import { health, version } from '../controllers/meta.controller.js';

export const healthRouter = Router();
healthRouter.get('/', health);

export const versionRouter = Router();
versionRouter.get('/', version);
