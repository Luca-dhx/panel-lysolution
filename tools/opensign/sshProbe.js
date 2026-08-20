// SONDE — le serveur de la cible TEST est-il joignable depuis ce poste ?
//
// Campagne de migration Yousign → OpenSign. Lecture seule, aucun octet envoyé
// au-delà de l'ouverture de socket : on veut savoir si un déploiement est
// possible AVANT de préparer quoi que ce soit, et l'apprendre autrement
// coûterait une release à moitié transférée.
//
// Aucune adresse n'est affichée : la réponse utile est « oui » ou « non ».
import net from 'node:net';
import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import PanelDeploymentTarget from '../../backend/src/models/PanelDeploymentTarget.model.js';

await connectDatabase();
const cible = await PanelDeploymentTarget.findOne({ environment: 'TEST' }).lean();
const host = cible?.sshHost;
const port = cible?.sshPort ?? 22;
console.log(`cible TEST : ${cible?.name} | hôte SSH renseigné : ${Boolean(host)} | port ${port}`);

if (host) {
  await new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 12_000 });
    socket.on('connect', () => { console.log('SSH : ATTEIGNABLE'); socket.destroy(); resolve(); });
    socket.on('timeout', () => { console.log('SSH : DÉLAI DÉPASSÉ'); socket.destroy(); resolve(); });
    socket.on('error', (e) => { console.log(`SSH : ERREUR (${e.code})`); resolve(); });
  });
}
console.log(`mot de passe VPS disponible dans l’environnement : ${Boolean(process.env.VPS_PASS)}`);
await disconnectDatabase();
