// Persistance du registre — MongoDB (bases TEST/PROD du Panel selon ENV).
// Interface stable depuis la Phase 2B : les services manipulent des fiches
// « plain object », le store est le seul à connaître Mongoose.
import PanelProject from '../../models/PanelProject.model.js';

const toRecord = (doc) => {
  if (!doc) return null;
  const { _id, ...record } = doc;
  return record;
};

export const registryStore = {
  async insert(record) {
    await PanelProject.create(record);
    return record;
  },

  async getById(projectId) {
    return toRecord(await PanelProject.findOne({ projectId }).lean());
  },

  async getByKey(projectKey) {
    return toRecord(await PanelProject.findOne({ projectKey }).lean());
  },

  // Recherche par ADRESSE — la fiche et le projet distant sont la même chose
  // vus des deux bouts. L'URL stockée est toujours normalisée (voir
  // projectIdentity.normalizeBackendUrl) : la comparaison est donc exacte.
  async getByBackendUrl(normalizedUrl) {
    if (!normalizedUrl) return null;
    return toRecord(await PanelProject.findOne({ 'runtime.publicBackendUrl': normalizedUrl }).lean());
  },

  async list() {
    return (await PanelProject.find({}).lean()).map(toRecord);
  },

  async save(record) {
    record.updatedAt = new Date().toISOString();
    const { _id, ...data } = record;
    await PanelProject.updateOne({ projectId: record.projectId }, { $set: data });
    return record;
  },

  async remove(projectId) {
    const result = await PanelProject.deleteOne({ projectId });
    return result.deletedCount > 0;
  },

  async clear() {
    await PanelProject.deleteMany({});
  },
};

export default registryStore;
