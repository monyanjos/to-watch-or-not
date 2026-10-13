"""Synchronise site/data.json avec les listes relevées dans Chrome.

Entrée : lists.json (à côté de ce script)
  {"nf":  [{"id": "81519223", "title": "The Glory"}, ...]   ou null si la liste n'a pas pu être lue
   "pv":  [{"id": "0FVU5GW8977QYZ5QYQ3ONWAMZ6", "title": "The Boys"}, ...]   ou null
   "atv": [{"url": "https://tv.apple.com/fr/show/...", "title": "Silo"}, ...]  ou null}

Sortie : site/data.json mis à jour, et changes.json (titres ajoutés / retirés, nouvelles affiches).
Une plateforme à null n'est pas touchée. Les numéros (pos) existants ne changent jamais.
"""
import json, os, sys, time, urllib.request, urllib.parse, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ac

DATA = os.path.join(HERE, 'site', 'data.json')
MAP = {'Crime & Thriller': 'Crime', 'Mystère & Thriller': 'Thriller', 'Action & Aventure': 'Action',
       'Science-Fiction': 'Science-fiction', 'Musique & Comédie Musicale': 'Musique',
       'Comédie Romantique': 'Romance', 'Histoire': 'Historique'}
PRI = ['Science-fiction', 'Horreur', 'Comédie', 'Crime', 'Romance', 'Musique', 'Historique', 'Action', 'Thriller', 'Drame', 'Documentaire']
M = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
PK = {'netflix': 'nf', 'max': 'hbo', 'amazonhbomax': 'hbo', 'amazonprimevideo': 'pv', 'molotovtv': 'mol', 'sfrplay': 'sfr', 'appletvplus': 'atv'}
JWQ = '''query S($q:String!){popularTitles(country:FR,first:5,filter:{searchQuery:$q}){edges{node{objectType ... on MovieOrShow{content(country:FR,language:"fr"){title originalReleaseYear originalReleaseDate posterUrl genres{translation(language:"fr")} scoring{imdbScore}} offers(country:FR,platform:WEB){monetizationType presentationType standardWebURL package{technicalName}}}}}}}'''
TECH = {'nf': ('netflix',), 'pv': ('amazonprimevideo',), 'atv': ('appletvplus', 'amazonappletvplus')}


def norm(t):
    t = unicodedata.normalize('NFKD', t or '').encode('ascii', 'ignore').decode().lower()
    return ''.join(c for c in t if c.isalnum())


def jw(title, src):
    req = urllib.request.Request('https://apis.justwatch.com/graphql',
                                 data=json.dumps({"query": JWQ, "variables": {"q": title}}).encode(),
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    res = [e['node'] for e in json.load(urllib.request.urlopen(req, timeout=20))['data']['popularTitles']['edges']]
    if not res:
        return None
    # préférer le résultat proposé sur la plateforme d'origine, puis le titre identique
    on = [n for n in res if any(f['package']['technicalName'] in TECH[src] for f in n['offers'])]
    same = [n for n in (on or res) if norm(n['content']['title']) == norm(title)]
    return (same or on or res)[0]


def build(pos, src, ref, title):
    n = jw(title, src)
    if not n:
        c = {'title': title}
        return {"pos": pos, "src": [src], src: ref, "title": title, "type": 'Film', "date": '', "acP": None, "acS": None,
                "imdb": None, "offers": [], "note": 'Fiche à compléter : titre introuvable sur JustWatch.', "genre": '', "poster": None}
    c = n['content']
    gs = [MAP.get(g['translation'], g['translation']) for g in c['genres']]
    typ = 'Série' if n['objectType'] == 'SHOW' else 'Film'
    if 'Documentaire' in gs:
        typ = 'Documentaire'
    genre = ' · '.join([g for g in PRI if g in gs and not (typ == 'Documentaire' and g == 'Documentaire')][:2])
    rd = c.get('originalReleaseDate')
    date = f"{int(rd[8:10])} {M[int(rd[5:7]) - 1]} {rd[:4]}" if rd else str(c.get('originalReleaseYear') or '')
    offers, rank = {}, {'4K': 3, 'HD': 2, 'SD': 1}
    for f in n['offers']:
        if f['monetizationType'] != 'FLATRATE':
            continue
        k = PK.get(f['package']['technicalName'])
        if not k:
            continue
        q = {'_4K': '4K', 'HD': 'HD', 'SD': 'SD'}.get(f['presentationType'], 'HD')
        if k not in offers or rank[q] > rank[offers[k][1]]:
            offers[k] = [k, q, f['standardWebURL']]
    if src == 'pv':
        offers['pv'] = ['pv', offers.get('pv', ['pv', 'HD'])[1], 'https://www.primevideo.com/detail/' + ref]
    elif src == 'atv':
        offers['atv'] = ['atv', offers.get('atv', ['atv', 'HD'])[1], ref]
    elif src == 'nf':
        offers['nf'] = ['nf', offers.get('nf', ['nf', 'HD'])[1]]
    off = [offers[src]] + [v for k, v in offers.items() if k != src]
    acr, acurl = {}, None
    try:
        yr = c.get('originalReleaseYear') or 0
        want = 'ficheserie' if typ == 'Série' else 'fichefilm'
        res = ac.search(c['title'], None)
        cand = [r for r in res if want in r[1] and any(str(yr + d) in r[2] for d in (-1, 0, 1))] or \
               [r for r in res if want in r[1] and norm(r[0]) == norm(c['title'])]
        if cand:
            acurl = 'https://www.allocine.fr' + cand[0][1]
            acr = ac.ratings(acurl)
    except Exception as e:
        print('AlloCiné', title, e)
    poster = None
    if c.get('posterUrl'):
        u = 'https://images.justwatch.com' + c['posterUrl'].replace('{profile}', 's332').replace('{format}', 'jpg')
        fn = f'posters/n{pos}.jpg'
        try:
            data = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=20).read()
            open(os.path.join(HERE, 'site', fn), 'wb').write(data)
            poster = fn
        except Exception as e:
            print('affiche', title, e)
    return {"pos": pos, "src": [src], src: ref, "title": c['title'], "type": typ, "date": date,
            "acP": acr.get('acP'), "acS": acr.get('acS'), "imdb": (c.get('scoring') or {}).get('imdbScore'),
            "offers": off, "note": None, "genre": genre, "poster": poster, "acUrl": acurl}


NAMES = {'nf': 'Netflix', 'pv': 'Prime Video', 'atv': 'Apple TV'}


def journal(*cols):
    """Ajoute une ligne horodatée à journal.log : date | plateforme | statut | détails."""
    line = time.strftime('%Y-%m-%d %H:%M:%S') + ' | ' + ' | '.join(str(c) for c in cols)
    with open(os.path.join(HERE, 'journal.log'), 'a') as f:
        f.write(line + '\n')


def main():
    lists = json.load(open(os.path.join(HERE, 'lists.json')))
    errors = lists.get('errors') or {}
    data = json.load(open(DATA))
    added, removed, posters = [], [], []
    by = {s: {'added': [], 'removed': []} for s in NAMES}
    nxt = max(x['pos'] for x in data) + 1
    for src in ('nf', 'pv', 'atv'):
        items = lists.get(src)
        if items is None:
            journal(NAMES[src], 'NON LU', errors.get(src) or 'liste non lue (aucun message transmis)')
            continue
        urls = {}
        if src == 'atv':  # Apple TV : les liens varient (épisode, série), on rapproche par le nom
            now = {norm(i['title']): i['title'] for i in items}
            urls = {norm(i['title']): i.get('url') for i in items}
        else:
            now = {str(i['id']).split('?')[0]: i['title'] for i in items}
        refof = (lambda x: x.get('atvKey') or norm(x['title'])) if src == 'atv' else (lambda x: str(x.get(src)))
        # retirés de la plateforme
        for x in data:
            if src in x.get('src', []) and refof(x) not in now:
                x['src'].remove(src)
                by[src]['removed'].append(x['title'])
                if not x['src']:
                    removed.append(x['title'])
        data = [x for x in data if x.get('src')]
        known = {refof(x) for x in data if src in x.get('src', [])}
        byname = {norm(x['title']): x for x in data}
        for ref, title in now.items():
            if ref in known:
                continue
            ex = byname.get(norm(title))
            link = (urls.get(ref) or 'https://tv.apple.com/fr/search?term=' + urllib.parse.quote(title)) if src == 'atv' else ref
            if ex:  # déjà présent depuis une autre plateforme
                ex['src'].append(src)
                by[src]['added'].append(ex['title'])
                ex[src] = link
                if src == 'atv':
                    ex['atvKey'] = ref
                continue
            it = build(nxt, src, link, title)
            if src == 'atv':
                it['atvKey'] = ref
            nxt += 1
            data.append(it)
            byname[norm(it['title'])] = it
            added.append(f"{it['title']} ({src})")
            by[src]['added'].append(it['title'])
            if it['poster']:
                posters.append(it['poster'])
            time.sleep(.4)
        a, r = by[src]['added'], by[src]['removed']
        journal(NAMES[src], 'lu', f'{len(items)} titres', f'+{len(a)} ' + (', '.join(a) or '-'), f'-{len(r)} ' + (', '.join(r) or '-'))
    json.dump(data, open(DATA, 'w'), ensure_ascii=False)
    journal('Site', 'data.json', f'{len(data)} titres au total')
    ch = {"added": added, "removed": removed, "posters": posters, "total": len(data)}
    json.dump(ch, open(os.path.join(HERE, 'changes.json'), 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(ch, ensure_ascii=False))


if __name__ == '__main__':
    main()
