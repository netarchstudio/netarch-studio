// Liaison GLPI pour NetArch Studio (aucune dépendance, Node 22+)
// Les réglages (adresse, port, jetons) sont saisis dans l'application et gardés dans la base SQLite.
// Les jetons restent côté serveur : ils ne sont jamais renvoyés au navigateur.

const PAGE = 100;

// Catégories proposées dans les réglages
const CATEGORIES = {
  network: 'Équipements réseau',
  server: 'Serveurs',
  workstation: 'Postes (PC)',
  printer: 'Imprimantes',
  phone: 'Téléphones'
};

// Ce que l'on lit dans GLPI : [type GLPI, libellé, champ "type", champ "modèle"]
const ITEMTYPES = [
  ['NetworkEquipment', 'Réseau', 'networkequipmenttypes_id', 'networkequipmentmodels_id'],
  ['Computer', 'Ordinateurs / serveurs', 'computertypes_id', 'computermodels_id'],
  ['Printer', 'Imprimantes', 'printertypes_id', 'printermodels_id'],
  ['Phone', 'Téléphones', 'phonetypes_id', 'phonemodels_id']
];

function buildUrl(s) {
  if (!s || !s.host) return '';
  const proto = s.protocol === 'https' ? 'https' : 'http';
  const port = Number(s.port) || (proto === 'https' ? 443 : 80);
  const p = String(s.path || '/glpi/apirest.php').replace(/\/+$/, '');
  return proto + '://' + s.host + ':' + port + p;
}

function checkConfig(c) {
  if (!c.url) return "Adresse GLPI manquante : renseignez l'adresse IP dans les réglages GLPI.";
  if (!c.appToken) return "Jeton d'application manquant dans les réglages GLPI.";
  if (!c.userToken) return 'Jeton utilisateur manquant dans les réglages GLPI.';
  return null;
}

async function api(c, p, headers) {
  let r;
  try {
    r = await fetch(c.url + p, { headers, signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw new Error('GLPI injoignable (' + c.url + ') : ' + ((e.cause && e.cause.code) || e.message));
  }
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}
  if (!r.ok) {
    const code = Array.isArray(body) ? body[0] : r.status;
    const msg = Array.isArray(body) ? body[1] : text.slice(0, 200);
    const err = new Error('GLPI a répondu ' + code + ' : ' + msg);
    err.glpiCode = Array.isArray(body) ? body[0] : null;
    throw err;
  }
  return body;
}

// Déduit le "type pour schéma" d'un équipement réseau
function guessType(e) {
  const t = [e.name, e.model, e.manufacturer, e.glpiType].join(' ').toLowerCase();
  if (/forti|palo ?alto|sonicwall|firewall|pare[- ]?feu|pfsense|opnsense|checkpoint/.test(t)) return 'pare_feu';
  if (/peplink|router|routeur|mikrotik|\bisr\b|\basr\b/.test(t)) return 'routeur';
  if (/nexus|datacenter/.test(t)) return 'switch_datacenter';
  if (/c-?9500|\bcore\b|c[œo]eur|catalyst 9[4-6]/.test(t)) return 'switch_core';
  if (/access ?point|borne|wifi|wi-fi|\bap\b|unifi|aruba iap/.test(t)) return 'point_acces_wifi';
  if (/load ?balanc|\bf5\b|\badc\b/.test(t)) return 'load_balancer';
  return 'switch_acces';
}

function guessTypeFor(itemtype, e) {
  if (itemtype === 'NetworkEquipment') return guessType(e);
  if (itemtype === 'Printer') return 'client_pc';
  if (itemtype === 'Phone') return 'telephone_ip';
  const t = [e.name, e.model, e.glpiType].join(' ').toLowerCase();
  if (/server|serveur|esxi|vmware|hyper-?v|proxmox|proliant|poweredge|\bsrv\b|\bdc\d|\bnas\b|synology|qnap/.test(t)) return 'serveur';
  return 'client_pc';
}

function guessStatus(stateName) {
  const s = String(stateName || '').toLowerCase();
  if (/maintenance|repair|répar/.test(s)) return 'maintenance';
  if (/hors|retired|offline|inactif|stock|rebut|panne|broken/.test(s)) return 'offline';
  return 'online';
}

function groupOf(itemtype, typeSchema) {
  if (itemtype === 'NetworkEquipment') return 'network';
  if (itemtype === 'Printer') return 'printer';
  if (itemtype === 'Phone') return 'phone';
  return typeSchema === 'serveur' ? 'server' : 'workstation';
}

function normalize(r, it) {
  const [itemtype, label, typeField, modelField] = it;
  const e = {
    itemtype,
    category: label,
    glpiId: Number(r.id),
    glpiKey: itemtype + ':' + r.id,
    name: String(r.name || ('Équipement GLPI #' + r.id)),
    glpiType: r[typeField] || '',
    manufacturer: r.manufacturers_id || '',
    model: r[modelField] || '',
    state: r.states_id || '',
    site: r.locations_id || '',
    serial: r.serial || '',
    comment: r.comment || ''
  };
  e.typeSchema = guessTypeFor(itemtype, e);
  e.group = groupOf(itemtype, e.typeSchema);
  e.status = guessStatus(e.state);
  return e;
}

// Lit GLPI (toutes les catégories) -> { equipments, warnings, counts }
async function fetchAll(c) {
  const bad = checkConfig(c);
  if (bad) { const err = new Error(bad); err.code = 'CONFIG'; throw err; }

  const s = await api(c, '/initSession', {
    'Content-Type': 'application/json',
    'Authorization': 'user_token ' + c.userToken,
    'App-Token': c.appToken
  });
  const h = { 'Session-Token': s.session_token, 'App-Token': c.appToken };
  const out = [];
  const warnings = [];
  try {
    for (const it of ITEMTYPES) {
      try {
        for (let start = 0; start < 5000; start += PAGE) {
          let rows;
          try {
            rows = await api(c, '/' + it[0] + '?expand_dropdowns=true&range=' + start + '-' + (start + PAGE - 1), h);
          } catch (e) {
            if (start > 0 && e.glpiCode === 'ERROR_RANGE_EXCEED_TOTAL') break; // fin de liste
            throw e;
          }
          if (!Array.isArray(rows) || !rows.length) break;
          rows.forEach(r => { if (!r.is_deleted && !r.is_template) out.push(normalize(r, it)); });
          if (rows.length < PAGE) break;
        }
      } catch (e) {
        // une catégorie inaccessible (droits du profil API) ne bloque pas les autres
        if (it[0] === 'NetworkEquipment' && !out.length) throw e;
        warnings.push(it[1] + ' : ' + e.message);
      }
    }
  } finally {
    try { await api(c, '/killSession', h); } catch (e) {}
  }
  const counts = {};
  Object.keys(CATEGORIES).forEach(k => { counts[k] = 0; });
  out.forEach(e => { counts[e.group]++; });
  return { equipments: out, warnings, counts };
}

module.exports = { CATEGORIES, buildUrl, checkConfig, fetchAll, guessType, guessStatus, normalize };
