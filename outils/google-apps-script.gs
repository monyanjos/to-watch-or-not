/**
 * To watch... or not - stockage partage et ajout de titres, sans ordinateur allume.
 *
 * A coller dans le projet Google Apps Script, puis : Deployer -> Gerer les deploiements ->
 * crayon -> Version : Nouvelle version -> Deployer (l'adresse /exec ne change pas).
 * Google demandera d'autoriser l'acces a Google Sheets et aux requetes externes : acceptez.
 *
 * Donnees gardees dans une feuille Google " To watch or not - donnees " (creee toute seule
 * dans votre Drive au premier appel) :
 *   onglet " etat "   : cellule A1 = {seen, removed, hist} (cases Deja vu et retraits)
 *   onglet " ajouts " : une ligne par titre ajoute depuis le site ou le raccourci iPhone
 *
 * Lecture  : GET  <url>                 -> {seen, removed, hist, added, updated}
 *            GET  <url>?a=search&q=Silo -> resultats de recherche (JustWatch)
 * Ecriture : POST <url> corps JSON
 *   {op:"seen", pos, value}      coche / decoche " Deja vu "
 *   {op:"remove", list:[pos...]}   retire un lot de titres
 *   {op:"undo"} / {op:"restore"} annule le dernier retrait / remet tout
 *   {op:"add", path, src}        ajoute un titre trouve par la recherche du site
 *   {op:"add", text}             ajoute depuis un lien partage (raccourci iPhone)
 *   {op:"sum", pos, sum}         ecrit le descriptif d'un titre ajoute
 *
 * Chaque nuit vers 4 h, refreshAdded() remet a jour les notes et plateformes des titres ajoutes.
 */
const MAX_POS = 1000000;
const FIRST_ADDED_POS = 10001;
const BOOK_NAME = 'To watch or not \u2013 donn\u00e9es';
const JW = 'https://apis.justwatch.com/graphql';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/130', 'Accept-Language': 'fr-FR' };
const PK = { netflix: 'nf', max: 'hbo', amazonhbomax: 'hbo', amazonprimevideo: 'pv', molotovtv: 'mol', sfrplay: 'sfr', appletvplus: 'atv', amazonappletvplus: 'atv' };
const NAMES = { nf: 'Netflix', pv: 'Prime Video', atv: 'Apple TV' };
const GENRE_MAP = { 'Crime & Thriller': 'Crime', 'Myst\u00e8re & Thriller': 'Thriller', 'Action & Aventure': 'Action', 'Science-Fiction': 'Science-fiction', 'Musique & Com\u00e9die Musicale': 'Musique', 'Com\u00e9die Romantique': 'Romance', 'Histoire': 'Historique' };
const GENRE_ORDER = ['Science-fiction', 'Horreur', 'Com\u00e9die', 'Crime', 'Romance', 'Musique', 'Historique', 'Action', 'Thriller', 'Drame', 'Documentaire'];
const MONTHS = ['janv.', 'f\u00e9vr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'ao\u00fbt', 'sept.', 'oct.', 'nov.', 'd\u00e9c.'];

/* ---------- Feuille Google ---------- */

function book_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('sheetId');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recr\u00e9\u00e9e plus bas */ } }
  const ss = SpreadsheetApp.create(BOOK_NAME);
  ss.getSheets()[0].setName('etat');
  ss.insertSheet('ajouts').appendRow(['pos', 'titre', 'plateforme', 'ajout\u00e9 le', 'donn\u00e9es (JSON)']);
  props.setProperty('sheetId', ss.getId());
  // reprise de l'ancien etat garde dans les proprietes du script
  const old = props.getProperty('state');
  if (old) ss.getSheetByName('etat').getRange('A1').setValue(old);
  return ss;
}

function readState_() {
  const ss = book_();
  const raw = ss.getSheetByName('etat').getRange('A1').getValue();
  const s = raw ? JSON.parse(raw) : {};
  return { seen: s.seen || {}, removed: s.removed || {}, hist: s.hist || [], updated: s.updated || null };
}

function writeState_(s) {
  s.updated = new Date().toISOString();
  book_().getSheetByName('etat').getRange('A1').setValue(JSON.stringify({ seen: s.seen, removed: s.removed, hist: s.hist, updated: s.updated }));
  return s;
}

function readAdded_() {
  const sh = book_().getSheetByName('ajouts');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 5, n, 1).getValues().map(r => { try { return JSON.parse(r[0]); } catch (e) { return null; } }).filter(Boolean);
}

function saveAdded_(item) {
  const sh = book_().getSheetByName('ajouts');
  const n = sh.getLastRow() - 1;
  const row = [item.pos, item.title, (item.src || []).map(k => NAMES[k] || k).join(', '), item.addedAt || '', JSON.stringify(item)];
  if (n >= 1) {
    const pos = sh.getRange(2, 1, n, 1).getValues().map(r => Number(r[0]));
    const i = pos.indexOf(item.pos);
    if (i >= 0) { sh.getRange(i + 2, 1, 1, 5).setValues([row]); return; }
  }
  sh.appendRow(row);
}

function fullState_(s) {
  s = s || readState_();
  s.added = readAdded_();
  return s;
}

/* ---------- Reponses HTTP ---------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function validPos_(p) { return Number.isInteger(p) && p > 0 && p < MAX_POS; }

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.a === 'search') return json_({ results: search_(p.q || '') });
  return json_(fullState_());
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureTrigger_();
    let req = {};
    try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { req = { text: (e && e.postData && e.postData.contents) || '' }; }
    const s = readState_();
    if (req.op === 'seen' && validPos_(req.pos)) {
      if (req.value) s.seen[req.pos] = true; else delete s.seen[req.pos];
    } else if (req.op === 'remove' && Array.isArray(req.list)) {
      const batch = req.list.filter(validPos_).filter(p => !s.removed[p]).slice(0, 500);
      batch.forEach(p => { s.removed[p] = true; });
      if (batch.length) s.hist.push(batch);
      s.hist = s.hist.slice(-200);
    } else if (req.op === 'undo') {
      (s.hist.pop() || []).forEach(p => { delete s.removed[p]; });
    } else if (req.op === 'restore') {
      s.removed = {}; s.hist = [];
    } else if (req.op === 'add' || (!req.op && (req.text || req.url))) {
      const res = add_(req);
      const st = fullState_(s);
      st.message = res.message; st.item = res.item || null; st.ok = !!res.item;
      return json_(st);
    } else if (req.op === 'sum' && validPos_(req.pos)) {
      const it = readAdded_().filter(x => x.pos === req.pos)[0];
      if (it) { it.sum = String(req.sum || '').slice(0, 300); saveAdded_(it); }
      return json_(fullState_(s));
    } else {
      const st = fullState_(s); st.error = 'requ\u00eate inconnue'; return json_(st);
    }
    return json_(fullState_(writeState_(s)));
  } finally {
    lock.releaseLock();
  }
}

/* ---------- JustWatch ---------- */

function gql_(query, variables) {
  const r = UrlFetchApp.fetch(JW, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ query: query, variables: variables }), muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  return JSON.parse(r.getContentText()).data;
}

const Q_SEARCH = 'query S($q:String!){popularTitles(country:FR,first:8,filter:{searchQuery:$q}){edges{node{objectType ... on MovieOrShow{content(country:FR,language:"fr"){title originalReleaseYear fullPath posterUrl shortDescription} offers(country:FR,platform:WEB){monetizationType package{technicalName}}}}}}}';
const Q_TITLE = 'query T($p:String!){urlV2(fullPath:$p){node{... on MovieOrShow{objectType content(country:FR,language:"fr"){title originalReleaseYear originalReleaseDate fullPath posterUrl genres{translation(language:"fr")} scoring{imdbScore} externalIds{imdbId}} offers(country:FR,platform:WEB){monetizationType presentationType standardWebURL package{technicalName}}}}}}';

function poster_(u) { return u ? 'https://images.justwatch.com' + u.replace('{profile}', 's332').replace('{format}', 'jpg') : null; }

function platformsOf_(offers) {
  const out = {};
  (offers || []).forEach(f => { if (f.monetizationType === 'FLATRATE') { const k = PK[f.package.technicalName]; if (k === 'nf' || k === 'pv' || k === 'atv') out[k] = true; } });
  return Object.keys(out);
}

/* Premiere phrase du resume JustWatch, coupee a 160 caracteres, pour les propositions d'ajout. */
function shortDesc_(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.{20,160}?[.!?](\s|$)/);
  let out = m ? m[0].trim() : t.slice(0, 160);
  if (!m && t.length > 160) out = out.replace(/\s+\S*$/, '') + '\u2026';
  return out;
}

function search_(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const d = gql_(Q_SEARCH, { q: q });
  return ((d && d.popularTitles && d.popularTitles.edges) || []).map(e => e.node).filter(n => n && n.content).map(n => ({
    path: n.content.fullPath, title: n.content.title, year: n.content.originalReleaseYear,
    type: n.objectType === 'SHOW' ? 'S\u00e9rie' : 'Film', poster: poster_(n.content.posterUrl), platforms: platformsOf_(n.offers),
    desc: shortDesc_(n.content.shortDescription)
  }));
}

/* ---------- Lien partage -> titre ---------- */

function norm_(t) { return String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function fetchTitle_(url) {
  try {
    const html = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: UA }).getContentText();
    const pick = re => { const m = html.match(re); return m ? m[1] : null; };
    const cands = [
      pick(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i),
      pick(/<h1[^>]*>(?:<[^>]+>)*\s*([^<]+?)\s*</i),
      pick(/<title[^>]*>([^<]+)<\/title>/i)
    ];
    for (let t of cands) {
      if (!t) continue;
      t = t.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\u00a0/g, ' ');
      t = t.replace(/^\s*Prime Video\s*:\s*/i, '').replace(/^\s*Regarder\s+/i, '');
      t = t.replace(/\s*[|\-\u2013]\s*(Netflix.*|Site officiel.*|Prime Video|Apple\s?TV\+?)\s*$/i, '');
      t = t.replace(/\s*[-\u2013]\s*Saison\s+\d+\s*$/i, '').trim();
      if (t && !/^(Netflix|Prime Video|Apple\s?TV\+?)$/i.test(t)) return t;
    }
    return null;
  } catch (e) { return null; }
}

function fromShared_(text) {
  text = String(text || '');
  const um = text.match(/https?:\/\/\S+/);
  const url = um ? um[0].replace(/[)\].,;\u00bb"']+$/, '') : '';
  let src = null, nf = null, name = null;
  if (/netflix\.com/i.test(url)) { src = 'nf'; const m = url.match(/(?:title|watch)\/(\d+)/) || url.match(/jbv=(\d+)/); nf = m ? m[1] : null; }
  else if (/primevideo\.com|amazon\.[a-z.]+\/(?:gp\/video|dp)/i.test(url)) src = 'pv';
  else if (/tv\.apple\.com/i.test(url)) src = 'atv';
  // nom du titre dans le texte partage (" ... "), sinon depuis la page publique du titre
  const q = text.match(/[\u00ab"\u201c]\s*([^\u00bb"\u201d]+?)\s*[\u00bb"\u201d]/);
  if (q) name = q[1];
  if (!name && url) name = fetchTitle_(nf ? 'https://www.netflix.com/fr/title/' + nf : url);
  if (!name && /tv\.apple\.com/i.test(url)) { const m = url.match(/\/(?:show|movie)\/([^/]+)\//); if (m) name = decodeURIComponent(m[1]).replace(/-/g, ' '); }
  if (!name && !url) name = text.trim();
  return { src: src, nf: nf, url: url, name: name };
}

/* ---------- AlloCine ---------- */

function acDecode_(s) {
  s = s.replace(/ACr/g, '');
  while (s.length % 4) s += '=';
  try { return Utilities.newBlob(Utilities.base64Decode(s)).getDataAsString(); } catch (e) { return ''; }
}

function acFind_(title, year, isShow) {
  try {
    const html = UrlFetchApp.fetch('https://www.allocine.fr/rechercher/?q=' + encodeURIComponent(title), { muteHttpExceptions: true, headers: UA }).getContentText();
    const want = isShow ? 'ficheserie' : 'fichefilm';
    const blocks = html.split('<li class="mdl">').slice(1).map(b => b.split('</li>')[0]);
    let best = null;
    blocks.forEach(b => {
      const enc = (b.match(/ACr[A-Za-z0-9+/=]{20,}/g) || []).map(acDecode_);
      const link = enc.filter(l => l.indexOf(want) >= 0)[0];
      if (!link) return;
      const years = (b.replace(/<[^>]+>/g, ' ').match(/\b(19|20)\d\d\b/g) || []).map(Number);
      const tm = b.match(/meta-title-link">([^<]*)</);
      const sameYear = years.some(y => Math.abs(y - year) <= 1);
      const sameName = tm && norm_(tm[1]) === norm_(title);
      const score = (sameYear ? 2 : 0) + (sameName ? 1 : 0);
      if (!best || score > best.score) best = { url: 'https://www.allocine.fr' + link, score: score };
    });
    if (!best || best.score === 0) return {};
    const page = UrlFetchApp.fetch(best.url, { muteHttpExceptions: true, headers: UA }).getContentText();
    const out = { acUrl: best.url };
    const re = /rating-title"[^>]*>\s*([^<]+?)\s*<[\s\S]*?stareval-note"?>\s*([0-9],[0-9])/g;
    let m;
    while ((m = re.exec(page))) {
      const lab = m[1].toLowerCase(), v = parseFloat(m[2].replace(',', '.'));
      if (lab.indexOf('presse') >= 0 && out.acP == null) out.acP = v;
      else if (lab.indexOf('spectateur') >= 0 && out.acS == null) out.acS = v;
    }
    return out;
  } catch (e) { return {}; }
}

/* ---------- Fiche d'un titre ---------- */

function buildFromPath_(path) {
  const d = gql_(Q_TITLE, { p: path });
  const n = d && d.urlV2 && d.urlV2.node;
  if (!n || !n.content) return null;
  const c = n.content;
  const gs = (c.genres || []).map(g => GENRE_MAP[g.translation] || g.translation);
  let type = n.objectType === 'SHOW' ? 'S\u00e9rie' : 'Film';
  if (gs.indexOf('Documentaire') >= 0) type = 'Documentaire';
  const genre = GENRE_ORDER.filter(g => gs.indexOf(g) >= 0 && !(type === 'Documentaire' && g === 'Documentaire')).slice(0, 2).join(' \u00b7 ');
  const rd = c.originalReleaseDate;
  const date = rd ? Number(rd.slice(8, 10)) + ' ' + MONTHS[Number(rd.slice(5, 7)) - 1] + ' ' + rd.slice(0, 4) : String(c.originalReleaseYear || '');
  const rank = { '4K': 3, HD: 2, SD: 1 }, offers = {};
  (n.offers || []).forEach(f => {
    if (f.monetizationType !== 'FLATRATE') return;
    const k = PK[f.package.technicalName]; if (!k) return;
    const q = { _4K: '4K', HD: 'HD', SD: 'SD' }[f.presentationType] || 'HD';
    if (!offers[k] || rank[q] > rank[offers[k][1]]) offers[k] = [k, q, f.standardWebURL];
  });
  const ac = acFind_(c.title, c.originalReleaseYear || 0, n.objectType === 'SHOW');
  return {
    jwPath: c.fullPath, title: c.title, type: type, date: date, genre: genre,
    imdb: (c.scoring && c.scoring.imdbScore) || null, imdbId: (c.externalIds && c.externalIds.imdbId) || null,
    acP: ac.acP == null ? null : ac.acP, acS: ac.acS == null ? null : ac.acS, acUrl: ac.acUrl || null,
    poster: poster_(c.posterUrl), offersMap: offers
  };
}

function add_(req) {
  let path = req.path, src = req.src, nf = null, url = '', name = null;
  if (!path) {
    const sh = fromShared_(req.text || req.url || '');
    src = src || sh.src; nf = sh.nf; url = sh.url; name = sh.name;
    if (!name) return { message: "Je n'ai pas reconnu de titre dans ce partage." };
    const res = search_(name);
    if (!res.length) return { message: '\u00ab ' + name + ' \u00bb est introuvable sur JustWatch.' };
    const same = res.filter(r => norm_(r.title) === norm_(name));
    const onSrc = (same.length ? same : res).filter(r => src && r.platforms.indexOf(src) >= 0);
    path = (onSrc[0] || same[0] || res[0]).path;
  }
  const f = buildFromPath_(path);
  if (!f) return { message: 'Fiche introuvable sur JustWatch.' };
  const added = readAdded_();
  const dup = added.filter(x => x.jwPath === f.jwPath || norm_(x.title) === norm_(f.title))[0];
  if (dup) return { item: dup, message: '\u00ab ' + dup.title + ' \u00bb est d\u00e9j\u00e0 dans To watch\u2026 or not.' };
  if (!src) src = ['nf', 'pv', 'atv'].filter(k => f.offersMap[k])[0] || 'nf';
  const offers = f.offersMap;
  if (src === 'nf' && nf) offers.nf = ['nf', (offers.nf || ['nf', 'HD'])[1], 'https://www.netflix.com/title/' + nf];
  if ((src === 'pv' || src === 'atv') && url) offers[src] = [src, (offers[src] || [src, 'HD'])[1], url];
  const first = offers[src] ? [offers[src]] : [];
  const props = PropertiesService.getScriptProperties();
  const pos = Number(props.getProperty('nextPos') || FIRST_ADDED_POS);
  props.setProperty('nextPos', String(pos + 1));
  const item = {
    pos: pos, src: [src], added: true, addedAt: new Date().toISOString(), jwPath: f.jwPath,
    link: (offers[src] && offers[src][2]) || url || null, nf: src === 'nf' ? nf : undefined,
    title: f.title, type: f.type, date: f.date, genre: f.genre,
    acP: f.acP, acS: f.acS, acUrl: f.acUrl, imdb: f.imdb, imdbId: f.imdbId,
    offers: first.concat(Object.keys(offers).filter(k => k !== src).map(k => offers[k])),
    poster: f.poster, sum: '', note: null
  };
  saveAdded_(item);
  return { item: item, message: '\u00ab ' + item.title + ' \u00bb ajout\u00e9 \u00e0 To watch\u2026 or not (' + (NAMES[src] || src) + ').' };
}

/* ---------- Mise a jour de nuit ---------- */

function refreshAdded() {
  readAdded_().forEach(it => {
    if (!it.jwPath) return;
    try {
      const f = buildFromPath_(it.jwPath);
      if (!f) return;
      ['imdb', 'imdbId', 'acP', 'acS', 'acUrl', 'poster', 'genre'].forEach(k => { if (f[k] != null) it[k] = f[k]; });
      const src = it.src[0], keep = (it.offers || []).filter(o => o[0] === src);
      it.offers = keep.concat(Object.keys(f.offersMap).filter(k => k !== src).map(k => f.offersMap[k]));
      it.refreshedAt = new Date().toISOString();
      saveAdded_(it);
      Utilities.sleep(500);
    } catch (e) { /* on passe au suivant */ }
  });
}

function ensureTrigger_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('trigger')) return;
  try {
    if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'refreshAdded')) {
      ScriptApp.newTrigger('refreshAdded').timeBased().everyDays(1).atHour(4).create();
    }
    props.setProperty('trigger', '1');
  } catch (e) { /* sera retent\u00e9 au prochain appel */ }
}

/* A lancer une fois a la main dans l'editeur (menu " Executer ") pour tout autoriser d'un coup. */
function installer() {
  book_();
  ensureTrigger_();
  Logger.log('Feuille : ' + book_().getUrl());
  Logger.log('Test recherche : ' + JSON.stringify(search_('Silo').slice(0, 1)));
}
