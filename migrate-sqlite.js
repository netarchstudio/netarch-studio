// Copie l'ancienne base SQLite (data/netarch.db) vers MySQL : schéma, historique, réglages GLPI et catalogue.
// Usage (voir README) : docker compose --profile migrate run --rm migrate
// La base SQLite d'origine n'est jamais modifiée (le script en travaille une copie).
const fs = require('fs');
const { pool, init } = require('./db');

const file = process.argv[2] || '/old/netarch.db';

(async () => {
  if (!fs.existsSync(file)) { console.error('Fichier introuvable : ' + file + '\nPlacez votre ancienne base dans le dossier ./data (data/netarch.db).'); process.exit(1); }
  const { DatabaseSync } = require('node:sqlite');   // demande Node 22.5+ (inclus dans l'image Docker)
  // On travaille sur une COPIE (avec ses fichiers -wal et -shm s'ils existent) : l'original n'est jamais touché
  // et les dernières modifications non encore fusionnées dans netarch.db sont bien reprises.
  const os = require('os'), path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netarch-'));
  const copy = path.join(tmp, 'netarch.db');
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
  const old = new DatabaseSync(copy);
  await init();

  const has = t => !!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const n = {};

  if (has('schema_current')) {
    const r = old.prepare('SELECT data FROM schema_current WHERE id=1').get();
    if (r) { await pool.query('INSERT INTO schema_current(id,data) VALUES(1,?) ON DUPLICATE KEY UPDATE data=VALUES(data)', [r.data]); n.schema = 1; }
  }
  if (has('schema_history')) {
    const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM schema_history');
    if (c.n === 0) {
      const rows = old.prepare('SELECT data,saved_at FROM schema_history ORDER BY id').all();
      for (const r of rows) await pool.query('INSERT INTO schema_history(data,saved_at) VALUES(?,?)', [r.data, r.saved_at]);
      n.historique = rows.length;
    } else n.historique = 'ignoré (déjà rempli dans MySQL)';
  }
  if (has('app_settings')) {
    const rows = old.prepare('SELECT key,value FROM app_settings').all();
    for (const r of rows) await pool.query('INSERT INTO app_settings(setting_key,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)', [r.key, r.value]);
    n.reglages = rows.length;
  }
  if (has('custom_catalog')) {
    const rows = old.prepare('SELECT id,data,created_at FROM custom_catalog ORDER BY created_at').all();
    for (const r of rows) await pool.query('INSERT INTO custom_catalog(id,data,created_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)', [r.id, r.data, r.created_at]);
    n.catalogue = rows.length;
  }
  console.log('Migration terminée :', n);
  old.close();
  await pool.end();
})().catch(e => { console.error('Échec de la migration :', e.message); process.exit(1); });
