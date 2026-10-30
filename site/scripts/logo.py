from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

f = TTFont('node_modules/vitepress/dist/client/theme-default/fonts/inter-roman-latin.woff2')
f = instantiateVariableFont(f, {'wght': 650, 'opsz': 32})
gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f['head'].unitsPerEm
H = 32.0            # logo height in user units; mark is H x H
cap = 0.62 * H      # cap height of the wordmark
scale = cap / f['OS/2'].sCapHeight
baseline = (H + cap) / 2
x0 = H + 9          # gap after the mark
pen = SVGPathPen(gs)
x = 0.0
track = -0.01 * upm
for ch in 'Kinote':
    g = cmap[ord(ch)]
    tp = TransformPen(pen, (scale, 0, 0, -scale, x0 + x * scale, baseline))
    gs[g].draw(tp)
    x += gs[g].width + track
width = x0 + x * scale + 1
d = pen.getCommands()

mark = '''<rect width="32" height="32" rx="8" fill="#6550c9"/>
  <g stroke="#fff" stroke-width="3.4" stroke-linecap="round" fill="none"><path d="M10.5 8.5v15"/><path d="M10.5 16 19.5 9.6M10.5 16l9 6.4"/></g>
  <g fill="#fff"><circle cx="21.6" cy="8.4" r="2.9"/><circle cx="21.6" cy="23.6" r="2.9"/></g>'''

def logo(fg):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} 32" height="32" role="img" aria-label="Kinote">
  {mark}
  <path fill="{fg}" d="{d}"/>
</svg>
'''
open('site/public/logo-light.svg', 'w').write(logo('#24211d'))
open('site/public/logo-dark.svg', 'w').write(logo('#ece6dd'))
open('site/public/mark.svg', 'w').write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" height="32" role="img" aria-label="Kinote">
  {mark}
</svg>
''')
print(width)
