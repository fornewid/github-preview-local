#!/usr/bin/env python3
"""Side-by-side and difference images of github.com captures vs prv captures.

    python3 compare.py <github dir> <prv dir> <out dir> [--align-gh Y --align-prv Y]

Both captures are 1440x900 CSS px (2x). The page above the pull request toolbar differs (github.com
has its global header and repository navigation), so images are aligned at the toolbar: pass the
toolbar's top (CSS px) in each capture.
"""
import argparse
import os
import sys

from PIL import Image, ImageChops, ImageDraw

p = argparse.ArgumentParser()
p.add_argument('gh')
p.add_argument('prv')
p.add_argument('out')
p.add_argument('--align-gh', type=float, default=0)
p.add_argument('--align-prv', type=float, default=0)
a = p.parse_args()
os.makedirs(a.out, exist_ok=True)

for name in sorted(os.listdir(a.gh)):
    if not name.endswith('.png') or not os.path.exists(os.path.join(a.prv, name)):
        continue
    g = Image.open(os.path.join(a.gh, name)).convert('RGB')
    l = Image.open(os.path.join(a.prv, name)).convert('RGB')
    scale = g.width / 1440
    dy = round((a.align_gh - a.align_prv) * scale)
    # Shift github.com up so both toolbars share the same y.
    if dy > 0:
        g = g.crop((0, dy, g.width, g.height))
    elif dy < 0:
        l = l.crop((0, -dy, l.width, l.height))
    h = min(g.height, l.height)
    g, l = g.crop((0, 0, g.width, h)), l.crop((0, 0, l.width, h))
    gap = 12
    sbs = Image.new('RGB', (g.width + l.width + gap, h), (255, 0, 0))
    sbs.paste(g, (0, 0))
    sbs.paste(l, (g.width + gap, 0))
    small = sbs.resize((sbs.width // 2, sbs.height // 2))
    small.save(os.path.join(a.out, 'sbs-' + name))
    diff = ImageChops.difference(g, l).convert('L').point(lambda v: 255 if v > 24 else 0)
    ratio = sum(diff.histogram()[255:]) / (diff.width * diff.height)
    overlay = Image.blend(g, Image.new('RGB', g.size, (255, 255, 255)), 0.6)
    overlay.paste((255, 0, 64), mask=diff)
    overlay.resize((overlay.width // 2, overlay.height // 2)).save(os.path.join(a.out, 'diff-' + name))
    print(f'{name}: {ratio * 100:.1f}% of pixels differ')
