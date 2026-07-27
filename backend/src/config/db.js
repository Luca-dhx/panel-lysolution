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
  logger.success(`MongoDB connectée (ENV=${config.env}, base=${config.dbName})`);
});
mongoose.connection.on('error', (err) => {
  logger.error(`Erreur MongoDB : ${err.message}`);
});
mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB déconnectée');
});

export async function connectDatabase() {
  await mongoose.connect(config.mongoUri, {
    dbName: config.dbName,
    serverSelectionTimeoutMS: 10_000,
  });
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
