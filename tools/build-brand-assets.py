"""Rebuild PNG/ICO and themed install manifests from the path-only master SVGs.
Development dependency: python -m pip install cairosvg pillow
Run from any directory: python tools/build-brand-assets.py
"""
from pathlib import Path
from io import BytesIO
import json, re
import cairosvg
from PIL import Image
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
VERSION = re.search(r'BROWSER · (v[\d.]+)', (ROOT/'index.html').read_text())[1]
THEMES = dict(re.findall(r"(\w+):\{scheme:'(?:dark|light)',color:'(#[0-9a-f]+)'\}", (ROOT/'app.js').read_text()))

def render(name, size):
    return Image.open(BytesIO(cairosvg.svg2png(url=str(ASSETS/name), output_width=size))).convert('RGBA')

def home(size, background, scale=.84):
    # Render at 3x and downsample for smooth small-size contours.
    canvas = Image.new('RGBA', (size*3, size*3), background)
    art = render('icon.svg', round(size*3*scale))
    offset = (size*3-art.width)//2
    canvas.alpha_composite(art, (offset, offset))
    return canvas.convert('RGB').resize((size,size), Image.Resampling.LANCZOS)

for size in (192,512):
    render('icon.svg', size*3).resize((size,size),Image.Resampling.LANCZOS).save(ASSETS/f'icon-{size}.png')
render('header-logo.svg',2172).resize((1086,362),Image.Resampling.LANCZOS).save(ASSETS/'header-logo.png')
render('icon.svg',96).resize((32,32),Image.Resampling.LANCZOS).save(ASSETS/'favicon-32.png')
render('icon.svg',192).save(ASSETS/'favicon.ico', sizes=[(16,16),(32,32),(48,48)])
home(180,THEMES['midnight']).save(ASSETS/'apple-touch-icon.png')
base=json.loads((ROOT/'manifest.webmanifest').read_text())
base['id']='./index.html'
(ASSETS/'home').mkdir(exist_ok=True)
(ROOT/'manifests').mkdir(exist_ok=True)
for theme,background in THEMES.items():
    for size in (180,192,512):
        home(size,background).save(ASSETS/'home'/f'{theme}-{size}.png')
    # The entire illustration fits within the maskable icon's safe circle.
    home(512,background,.60).save(ASSETS/'home'/f'{theme}-maskable-512.png')
    manifest={**base,'id':'../index.html','start_url':f'../index.html?theme={theme}','scope':'../',
              'background_color':background,'theme_color':background,'icons':[
        {'src':f'../assets/home/{theme}-{size}.png?{VERSION}','sizes':f'{size}x{size}','type':'image/png','purpose':'any'} for size in (192,512)] + [
        {'src':f'../assets/home/{theme}-maskable-512.png?{VERSION}','sizes':'512x512','type':'image/png','purpose':'maskable'}]}
    (ROOT/'manifests'/f'{theme}.webmanifest').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    if theme=='midnight':
        default={**manifest,'id':'./index.html','start_url':'./index.html','scope':'./',
                 'icons':[{**icon,'src':icon['src'].removeprefix('../')} for icon in manifest['icons']]}
        (ROOT/'manifest.webmanifest').write_text(json.dumps(default,ensure_ascii=False,indent=2)+'\n')
print(f'Rebuilt {len(THEMES)} themes for {VERSION}.')
