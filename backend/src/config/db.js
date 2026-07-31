// Connexion MongoDB — même discipline que le projet modèle :
//  - mongoose, URI commune, le NOM de base vient de la config validée
//    (option dbName — jamais concaténé dans l'URI) ;
//  - l'URI n'est JAMAIS journalisée (elle peut contenir des credentials) :
//    les logs n'affichent que ENV et le nom de base.
import mongoose from 'mongoose';
import config from './env.js';
import logger from '../utils/logger.js';

mongoose.set('strictQuery', true);

mongoose.connection.on('connected', () => {
  // L'HÔTE est journalisé, jamais l'URI complète — celle-ci contient des
  // identifiants. Sans cette ligne, une connexion partie vers la mauvaise
  // adresse était indétectable : les journaux ne disaient que le nom de la
  // base, identique d'un serveur à l'autre.
  logger.success(
    `MongoDB connectée — ${config.mongoHost}, base « ${config.dbName} » (ENV=${config.env})`,
  );
});
mongoose.connection.on('error', (err) => {
  logger.error(`Erreur MongoDB : ${err.message}`);
});
mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB déconnectée');
});

export async function connectDatabase() {
  // Un Panel de PRODUCTION pointant sur une base locale est presque toujours
  // un `.env` oublié. On ne bloque pas — un déploiement peut légitimement
  // héberger sa base sur la même machine — mais on le DIT fort, parce que
  // c'est la panne la plus coûteuse à découvrir après coup.
  if (config.isProd && config.mongoIsLocal) {
    logger.warn(
      `ENV=PROD mais MONGODB_URI pointe sur ${config.mongoHost} : `
      + 'vérifiez qu’il s’agit bien de la base de production.',
    );
  }

  try {
    await mongoose.connect(config.mongoUri, {
      dbName: config.dbName,
      serverSelectionTimeoutMS: 10_000,
    });
  } catch (err) {
    // Le message brut du pilote est illisible et ne nomme pas la cause la
    // plus fréquente. On le complète sans le masquer.
    throw new Error(
      `Connexion à MongoDB impossible (${config.mongoHost}) : ${err.message}\n`
      + '  · vérifiez MONGODB_URI dans backend/.env ;\n'
      + '  · sur Atlas, vérifiez que votre adresse IP est autorisée (Network Access) ;\n'
      + '  · vérifiez que l’utilisateur et le mot de passe sont corrects.',
      { cause: err },
    );
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
