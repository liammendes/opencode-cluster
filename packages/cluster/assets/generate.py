"""Outline the wordmark; requires fonttools==4.60.2 and the pinned DynaPuff font."""

import hashlib
import pathlib
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

font_path = pathlib.Path(sys.argv[1])
expected = "c3752fc6dd8aaa46a88637f061a9a4e6ab44c02c5f0afd65528b91ae8ff6f948"
if hashlib.sha256(font_path.read_bytes()).hexdigest() != expected:
    raise SystemExit("Use the pinned DynaPuff font described in assets/README.md.")

font = instantiateVariableFont(TTFont(font_path), {"wght": 700, "wdth": 100})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
bounds = BoundsPen(glyphs)
parts = []
cursor = 0

for word in ("opencode", "-", "cluster"):
    path = SVGPathPen(glyphs, ntos=lambda number: format(number, ".2f").rstrip("0").rstrip("."))
    for char in word:
        name = cmap[ord(char)]
        transform = (1, 0, 0, -1, cursor, 0)
        glyphs[name].draw(TransformPen(path, transform))
        glyphs[name].draw(TransformPen(bounds, transform))
        cursor += font["hmtx"][name][0] - 14
    parts.append(path.getCommands())

left, top, right, bottom = bounds.bounds
scale = 1120 / (right - left)
height = (bottom - top) * scale + 88
transform = f"translate({40 - left * scale:.3f} {44 - top * scale:.3f}) scale({scale:.6f})"
themes = {
    "light": ("#192A3A", "#C35426"),
    "dark": ("#F8F1E7", "#FFAC7C"),
}

for theme, (ink, accent) in themes.items():
    paths = "\n".join(
        f'    <path fill="{accent if index == 2 else ink}" d="{path}"/>'
        for index, path in enumerate(parts)
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height:.3f}" viewBox="0 0 1200 {height:.3f}" role="img" aria-labelledby="title desc">
  <title id="title">opencode-cluster</title>
  <desc id="desc">A bubbly lowercase wordmark, with opencode and a hyphen in {'ink blue' if theme == 'light' else 'warm white'} and cluster in {'burnt orange' if theme == 'light' else 'peach'}.</desc>
  <!-- DynaPuff Bold, outlined. See README.md and DynaPuff-OFL.txt beside this file. -->
  <g transform="{transform}">
{paths}
  </g>
</svg>
"""
    output = pathlib.Path(__file__).parent / f"wordmark-{theme}.svg"
    output.write_text(svg)
    print(f"{output.name}: 1200 x {height:.3f}")
