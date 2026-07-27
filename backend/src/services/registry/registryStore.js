// Persistance du registre — Phase 2B : en mémoire.
// L'interface est stable : la Phase 3 la réimplémente sur Mongo (bases
// TEST/PROD du Panel) sans changer une signature — même démarche que le
// pairingStore du projet modèle.
const records = new Map(); // projectId -> record

export const registryStore = {
  insert(record) {
    records.set(record.projectId, record);
    return record;
  },

  getById(projectId) {
    return records.get(projectId) ?? null;
  },

  getByKey(projectKey) {
    for (const record of records.values()) {
      if (record.projectKey === projectKey) return record;
    }
    return null;
  },

  list() {
    return [...records.values()];
  },

  save(record) {
    record.updatedAt = new Date().toISOString();
    records.set(record.projectId, record);
    return record;
  },

  remove(projectId) {
    return records.delete(projectId);
  },

  clear() {
    records.clear();
  },
};

export default registryStore;
