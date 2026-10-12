/**
 * To watch… or not — stockage partagé des coches « Déjà vu » et des retraits.
 * À coller dans un projet Google Apps Script, puis : Déployer → Nouveau déploiement →
 * Application Web, « Exécuter en tant que : Moi », « Qui a accès : Tout le monde ».
 *
 * État gardé dans les propriétés du script :
 *   { seen: {"<pos>": true}, removed: {"<pos>": true}, hist: [[pos, ...], ...], updated: "<date ISO>" }
 */
const KEY = 'state';
const MAX_POS = 100000;

function readState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(KEY);
  const s = raw ? JSON.parse(raw) : {};
  return { seen: s.seen || {}, removed: s.removed || {}, hist: s.hist || [], updated: s.updated || null };
}

function writeState_(s) {
  s.updated = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(KEY, JSON.stringify(s));
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function validPos_(p) {
  return Number.isInteger(p) && p > 0 && p < MAX_POS;
}

// Lecture : GET <url>
function doGet() {
  return json_(readState_());
}

// Écriture : POST <url> avec un corps texte JSON
//   {op:"seen", pos:12, value:true}     coche ou décoche « Déjà vu »
//   {op:"remove", list:[12, 40]}        retire un lot de titres
//   {op:"undo"}                         annule le dernier lot retiré
//   {op:"restore"}                      remet tous les titres
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const s = readState_();
    if (req.op === 'seen' && validPos_(req.pos)) {
      if (req.value) s.seen[req.pos] = true; else delete s.seen[req.pos];
    } else if (req.op === 'remove' && Array.isArray(req.list)) {
      const batch = req.list.filter(validPos_).filter(p => !s.removed[p]).slice(0, 500);
      batch.forEach(p => { s.removed[p] = true; });
      if (batch.length) s.hist.push(batch);
      s.hist = s.hist.slice(-200);
    } else if (req.op === 'undo') {
      const batch = s.hist.pop() || [];
      batch.forEach(p => { delete s.removed[p]; });
    } else if (req.op === 'restore') {
      s.removed = {};
      s.hist = [];
    } else {
      return json_({ error: 'requête inconnue', state: s });
    }
    return json_(writeState_(s));
  } finally {
    lock.releaseLock();
  }
}
