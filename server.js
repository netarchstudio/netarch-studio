// NetArch Studio - serveur local (Node.js 18+) avec base MySQL
// Réglages de la base : variables d'environnement DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME (voir .env.example)
// Adresse : http://localhost:3737
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pool, init: initDb } = require('./db');
const glpi = require('./glpi');

const PORT = process.env.PORT || 3737;

const getCur = async () => (await pool.query('SELECT data FROM schema_current WHERE id=1'))[0][0];
const TRIM_SQL = 'DELETE FROM schema_history WHERE id < (SELECT m FROM (SELECT MIN(id) AS m FROM (SELECT id FROM schema_history ORDER BY id DESC LIMIT 200) t) x)';

let lastAutoSave = '';

async function saveSchema(json) {
  const old = await getCur();
  if (old && old.data === json) return;
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    await c.query(`INSERT INTO schema_current(id,data) VALUES(1,?) ON DUPLICATE KEY UPDATE data=VALUES(data)`, [json]);
    await c.query('INSERT INTO schema_history(data) VALUES(?)', [json]);   // chaque modification est historisée (200 dernières versions)
    await c.query(TRIM_SQL);
    await c.commit();
    lastAutoSave = json;
  } catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
}

// Sauvegarde programmée toutes les 5 minutes si des modifications non sauvegardées existent
setInterval(async () => {
  try {
    const current = await getCur();
    if (current && current.data !== lastAutoSave) {
      await pool.query('INSERT INTO schema_history(data) VALUES(?)', [current.data]);
      await pool.query(TRIM_SQL);
      lastAutoSave = current.data;
      console.log(`[${new Date().toISOString()}] Sauvegarde automatique programmée effectuée`);
    }
  } catch (e) {
    console.error('Erreur lors de la sauvegarde programmée:', e.message);
  }
}, 5 * 60 * 1000); // 5 minutes


// ---------- Réglages GLPI (adresse, port, jetons) ----------
const getSet = async key => (await pool.query('SELECT value FROM app_settings WHERE setting_key=?', [key]))[0][0];
const putSet = (key, value) => pool.query('INSERT INTO app_settings(setting_key,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)', [key, value]);
const GLPI_DEFAULTS = { protocol: 'http', host: '', port: 80, path: '/glpi/apirest.php', appToken: '', userToken: '',
  categories: ['network', 'server'], autoSync: true, intervalMin: 10 };
async function glpiSettings() {
  try { const r = await getSet('glpi'); return { ...GLPI_DEFAULTS, ...(r ? JSON.parse(r.value) : {}) }; }
  catch (e) { return { ...GLPI_DEFAULTS }; }
}
function publicGlpi(st) {
  const { appToken, userToken, ...rest } = st;
  return { ...rest, hasAppToken: !!appToken, hasUserToken: !!userToken, categoryLabels: glpi.CATEGORIES };
}
const glpiCfg = st => ({ url: glpi.buildUrl(st), appToken: st.appToken, userToken: st.userToken });
const sameTarget = (a, b) => a.protocol === b.protocol && a.host === b.host && Number(a.port) === Number(b.port) && a.path === b.path;

// Vérifie le formulaire reçu et le fusionne avec les réglages enregistrés
function mergeGlpi(old, b) {
  const st = { ...old };
  if (b.protocol !== undefined) st.protocol = b.protocol === 'https' ? 'https' : 'http';
  if (b.host !== undefined) {
    const h = String(b.host).trim();
    if (h && !/^[A-Za-z0-9._-]+$/.test(h)) throw new Error("Adresse invalide : saisissez une adresse IP ou un nom (ex : 192.168.127.128), sans http:// ni /.");
    st.host = h;
  }
  if (b.port !== undefined) {
    const n = Number(b.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Port invalide (1 à 65535).');
    st.port = n;
  }
  if (b.path !== undefined) {
    let p = String(b.path).trim();
    if (!p.startsWith('/')) p = '/' + p;
    if (/[\s?#]/.test(p)) throw new Error("Chemin de l'API invalide.");
    st.path = p;
  }
  if (Array.isArray(b.categories)) st.categories = b.categories.filter(k => glpi.CATEGORIES[k]);
  if (b.autoSync !== undefined) st.autoSync = !!b.autoSync;
  if (b.intervalMin !== undefined) st.intervalMin = Math.max(1, Math.min(1440, Number(b.intervalMin) || 10));
  const at = typeof b.appToken === 'string' ? b.appToken.trim() : '';
  const ut = typeof b.userToken === 'string' ? b.userToken.trim() : '';
  if (/\s/.test(at) || /\s/.test(ut)) throw new Error('Un jeton ne doit pas contenir d\'espace.');
  // Si l'adresse change, les jetons enregistrés ne sont plus envoyés à la nouvelle adresse : il faut les ressaisir
  if (!sameTarget(old, st)) {
    if (!at || !ut) throw new Error("L'adresse a changé : saisissez de nouveau les deux jetons.");
  }
  if (at) st.appToken = at;
  if (ut) st.userToken = ut;
  return st;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
// Liste blanche : seuls ces fichiers sont servis (la base data/netarch.db et le code serveur ne le sont jamais)
const PUBLIC_FILES = new Set(['index.html', 'catalog.js', 'styles.css', 'favicon.ico']);

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 50e6) { reject(new Error('trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');   // permet aussi l'ouverture directe de index.html
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('400'); }
  try {
    // ---------- API ----------
    if (p === '/api/schema' && req.method === 'GET') {
      const r = await getCur();
      return send(res, 200, { ok: true, schema: r ? JSON.parse(r.data) : null });
    }
    if (p === '/api/schema' && req.method === 'POST') {
      const b = await readBody(req);
      if (!Array.isArray(b.devices)) return send(res, 400, { ok: false, error: 'devices manquant' });
      await saveSchema(JSON.stringify({ devices: b.devices, links: b.links || [], vlans: b.vlans || [], glpiSeen: Array.isArray(b.glpiSeen) ? b.glpiSeen : [] }));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/history' && req.method === 'GET')
      return send(res, 200, (await pool.query('SELECT id,saved_at,LENGTH(data) AS taille FROM schema_history ORDER BY id DESC LIMIT 200'))[0]);
    let m;
    if ((m = p.match(/^\/api\/history\/(\d+)$/)) && req.method === 'GET') {
      const r = (await pool.query('SELECT data FROM schema_history WHERE id=?', [Number(m[1])]))[0][0];
      return r ? send(res, 200, { ok: true, schema: JSON.parse(r.data) }) : send(res, 404, { ok: false });
    }
    if (p === '/api/catalog/custom' && req.method === 'GET')
      return send(res, 200, { ok: true, entries: (await pool.query('SELECT data FROM custom_catalog ORDER BY created_at, id'))[0].map(r => JSON.parse(r.data)) });
    if (p === '/api/catalog/custom' && req.method === 'POST') {
      const e = await readBody(req);
      if (!e.id) return send(res, 400, { ok: false });
      await pool.query('INSERT INTO custom_catalog(id,data) VALUES(?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)', [String(e.id), JSON.stringify(e)]);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/glpi/settings' && req.method === 'GET') return send(res, 200, { ok: true, settings: publicGlpi(await glpiSettings()) });
    if (p === '/api/glpi/settings' && req.method === 'POST') {
      try {
        const st = mergeGlpi(await glpiSettings(), await readBody(req));
        await putSet('glpi', JSON.stringify(st));
        return send(res, 200, { ok: true, settings: publicGlpi(st) });
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if (p === '/api/glpi/test' && req.method === 'POST') {
      try {
        const st = mergeGlpi(await glpiSettings(), await readBody(req));   // teste les valeurs du formulaire, sans les enregistrer
        const r = await glpi.fetchAll(glpiCfg(st));
        return send(res, 200, { ok: true, total: r.equipments.length, counts: r.counts, labels: glpi.CATEGORIES, warnings: r.warnings });
      } catch (e) { return send(res, e.code === 'CONFIG' ? 400 : 502, { ok: false, error: e.message }); }
    }
    if (p === '/api/glpi/sync' && req.method === 'GET') {
      try {
        const st = await glpiSettings();
        const r = await glpi.fetchAll(glpiCfg(st));
        const on = new Set(st.categories);
        return send(res, 200, { ok: true, equipments: r.equipments.filter(e => on.has(e.group)), warnings: r.warnings, counts: r.counts });
      } catch (e) { return send(res, e.code === 'CONFIG' ? 400 : 502, { ok: false, error: e.message }); }
    }
    if (p.startsWith('/api/')) return send(res, 404, { ok: false, error: 'inconnu' });

    // ---------- Fichiers de l'application ----------
    if (p.includes('\0')) { res.writeHead(400); return res.end('400'); }
    const rel = path.posix.normalize(p === '/' ? '/index.html' : p.replace(/\\/g, '/')).replace(/^\/+/, '');
    if (!PUBLIC_FILES.has(rel)) { res.writeHead(404); return res.end('404 - fichier introuvable'); }
    const file = path.join(__dirname, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('404 - fichier introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('Erreur :', e.message);
    send(res, 500, { ok: false, error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\nERREUR : le port ${PORT} est déjà utilisé (le serveur tourne peut-être déjà dans une autre fenêtre).`);
  else console.error(e);
  process.exit(1);
});

async function shutdown() {
  console.log('\nArrêt du serveur…');
  server.close();
  try { await pool.end(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n NetArch Studio démarré\n   Ce PC      : http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`   Autres PC  : http://${i.address}:${PORT}`);
    console.log(`   Base MySQL : ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || 'netarch'}\n`);
  });
}).catch(e => { console.error('\nERREUR base de données :', e.message); process.exit(1); });
