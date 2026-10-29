"""Side-by-side sheet from render.py axis sheets: one row per run, columns = front (look -Z) and side (look +X).

  python compare.py <out.png> "<label>=<axes.png>" ...
"""
import sys

from PIL import Image, ImageDraw

TILES = {'front': (0, 1), 'side': (0, 0)}  # (col, row) in render.py's 3x2 sheet


def main():
    out, runs = sys.argv[1], [a.split('=', 1) for a in sys.argv[2:]]
    h = 512
    rows = []
    for label, path in runs:
        sheet = Image.open(path).convert('L')
        s = sheet.width // 3
        tiles = [sheet.crop((c * s, r * s, c * s + s, r * s + s)).resize((h, h)) for c, r in TILES.values()]
        row = Image.new('L', (h * len(tiles) + 260, h), 255)
        ImageDraw.Draw(row).multiline_text((10, h // 2 - 20), label.replace(' | ', '\n'), fill=0)
        for i, t in enumerate(tiles):
            row.paste(t, (260 + i * h, 0))
        rows.append(row)
    img = Image.new('L', (rows[0].width, h * len(rows)), 255)
    for i, r in enumerate(rows):
        img.paste(r, (0, i * h))
    img.save(out)


if __name__ == '__main__':
    main()
