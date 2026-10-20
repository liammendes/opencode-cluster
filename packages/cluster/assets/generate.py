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
highlights = []
cursor = 0
glints = {
    "o": (0.17, 0.32, 0.24, 0.13, 0.43, 0.13),
    "c": (0.17, 0.32, 0.24, 0.13, 0.43, 0.13),
    "e": (0.17, 0.32, 0.24, 0.13, 0.43, 0.13),
    "s": (0.17, 0.32, 0.24, 0.13, 0.43, 0.13),
    "p": (0.14, 0.26, 0.13, 0.12, 0.23, 0.10),
    "n": (0.14, 0.32, 0.13, 0.16, 0.23, 0.13),
    "r": (0.14, 0.32, 0.13, 0.16, 0.23, 0.13),
    "d": (0.73, 0.22, 0.69, 0.10, 0.80, 0.09),
    "l": (0.34, 0.24, 0.32, 0.12, 0.44, 0.10),
    "u": (0.16, 0.31, 0.13, 0.15, 0.23, 0.13),
    "t": (0.48, 0.21, 0.47, 0.10, 0.58, 0.09),
    "-": (0.18, 0.49, 0.28, 0.29, 0.48, 0.28),
}

for word in ("opencode", "-", "cluster"):
    path = SVGPathPen(glyphs, ntos=lambda number: format(number, ".2f").rstrip("0").rstrip("."))
    for char in word:
        name = cmap[ord(char)]
        transform = (1, 0, 0, -1, cursor, 0)
        glyphs[name].draw(TransformPen(path, transform))
        glyphs[name].draw(TransformPen(bounds, transform))
        letter = BoundsPen(glyphs)
        glyphs[name].draw(TransformPen(letter, transform))
        x0, y0, x1, y1 = letter.bounds
        points = glints[char]
        coordinates = [
            f"{x0 + points[index] * (x1 - x0):.2f} {y0 + points[index + 1] * (y1 - y0):.2f}"
            for index in range(0, 6, 2)
        ]
        highlights.append(f'M{coordinates[0]} Q{coordinates[1]} {coordinates[2]}')
        cursor += font["hmtx"][name][0] - 14
    parts.append(path.getCommands())

left, top, right, bottom = bounds.bounds
scale = 1120 / (right - left)
height = (bottom - top) * scale + 88
transform = f"translate({40 - left * scale:.3f} {44 - top * scale:.3f}) scale({scale:.6f})"
paths = "\n".join(f'      <path d="{path}"/>' for path in parts)
shine = " ".join(highlights)
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height:.3f}" viewBox="0 0 1200 {height:.3f}" role="img" aria-labelledby="title desc">
  <title id="title">opencode-cluster</title>
  <desc id="desc">Black bubbly lowercase lettering with a white sticker outline and shiny white highlights.</desc>
  <!-- DynaPuff Bold, outlined. See README.md and DynaPuff-OFL.txt beside this file. -->
  <defs>
    <g id="lettering" transform="{transform}">
{paths}
    </g>
    <path id="highlights" d="{shine}" transform="{transform}"/>
  </defs>
  <use href="#lettering" fill="#000000" stroke="#ffffff" stroke-width="76" stroke-linejoin="round" paint-order="stroke fill"/>
  <g fill="none" stroke="#ffffff" stroke-linecap="round">
    <use href="#highlights" stroke-width="48" opacity="0.16"/>
    <use href="#highlights" stroke-width="22" opacity="0.95"/>
  </g>
</svg>
"""
output = pathlib.Path(__file__).parent / "wordmark.svg"
output.write_text(svg)
print(f"{output.name}: 1200 x {height:.3f}")
