// Déclaration PM2 du backend du Panel. Le nom du service et les variables
// d'environnement viennent du déploiement (--update-env) ; ce fichier ne
// fige ni domaine, ni port, ni environnement.
module.exports = {
  apps: [
    {
      name: process.env.PANEL_SERVICE_NAME || 'panel-backend',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      // Le fichier .env est lu par config/env.js (dotenv) : PM2 n'a pas à
      // dupliquer les secrets dans sa propre configuration.
      env: {},
    },
  ],
};
