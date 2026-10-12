import re,base64,urllib.request,urllib.parse,json,time,html
UA={'User-Agent':'Mozilla/5.0 (Macintosh) Chrome/130','Accept-Language':'fr-FR'}
def get(u): return urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=20).read().decode('utf8','ignore')
def dec(x):
    x=x.replace('ACr','');x+='='*(-len(x)%4)
    try: return base64.b64decode(x).decode()
    except: return ''
def search(q,kind):
    s=get('https://www.allocine.fr/rechercher/?q='+urllib.parse.quote_plus(q))
    out=[]
    for blk in re.findall(r'<li class="mdl">(.*?)</li>',s,re.S):
        links=[dec(m) for m in re.findall(r'class="ACr([A-Za-z0-9+/=]+) [^"]*meta-title-link',blk)]+[dec(m) for m in re.findall(r'ACr([A-Za-z0-9+/=]{20,})',blk)]
        url=next((l for l in links if 'fichefilm_gen' in l or 'ficheserie_gen' in l),None)
        title=re.search(r'meta-title-link">([^<]*)<',blk) or re.search(r'alt="([^"]*)"',blk)
        yr=re.findall(r'\b(19\d\d|20\d\d)\b',re.sub(r'<[^>]+>',' ',blk))
        if url: out.append((html.unescape(title.group(1)) if title else '',url,yr[:3]))
    return out
def ratings(url):
    s=get('https://www.allocine.fr'+url if url.startswith('/') else url)
    r={}
    for lab,val in re.findall(r'rating-title"[^>]*>\s*([^<]+?)\s*<.*?stareval-note"?>\s*([0-9],[0-9])',s,re.S):
        lab=lab.strip().lower()
        if 'presse' in lab: r.setdefault('acP',float(val.replace(',','.')))
        elif 'spectateur' in lab: r.setdefault('acS',float(val.replace(',','.')))
    return r
if __name__=='__main__':
    import sys
    print(search(sys.argv[1],None)[:5])
