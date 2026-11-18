#!/usr/bin/env python3
"""RTXSwitch icon generator — renders assets/icon.ico + icon.png (512px).

Design: dark rounded tile, green-glowing toggle switch with the knob
slammed to the right (== "force high-performance GPU"), lightning bolt
inside the knob. Supersampled 4x for crisp anti-aliasing.
"""
from PIL import Image, ImageDraw, ImageFilter
import os

S = 4              # supersample factor
BASE = 512 * S     # working canvas
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def vertical_gradient(size, top, bottom):
    w, h = size
    g = Image.new('RGB', (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize(size)


def radial_glow(size, center, radius, color, peak_alpha):
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 26
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(peak_alpha * (1 - i / steps) ** 1.6)
        d.ellipse([center[0] - r, center[1] - r, center[0] + r, center[1] + r],
                  fill=color + (a,))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.12))


canvas = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))

# --- tile background: vertical gradient ---
bg = vertical_gradient((BASE, BASE), (26, 32, 44), (10, 13, 18)).convert('RGBA')
canvas.paste(bg, (0, 0))

# radial green glow behind the switch
glow = radial_glow((BASE, BASE), (BASE // 2, BASE // 2 + 10 * S), 240 * S, (118, 185, 0), 74)
canvas.alpha_composite(glow)

# --- rounded-rect clip for everything inside the tile ---
RADIUS = 118 * S
tile = rounded_mask((BASE, BASE), RADIUS)

inner = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))
draw = ImageDraw.Draw(inner)

# --- switch track (pill) ---
track_box = [86 * S, 186 * S, 426 * S, 326 * S]
# track shadow
sh = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))
ImageDraw.Draw(sh).rounded_rectangle(track_box, radius=70 * S, fill=(0, 0, 0, 150))
sh = sh.filter(ImageFilter.GaussianBlur(10 * S))
inner.alpha_composite(sh)
# track body: dark inset with subtle vertical gradient feel
track = vertical_gradient((track_box[2] - track_box[0], track_box[3] - track_box[1]),
                          (13, 17, 24), (6, 8, 12)).convert('RGBA')
track_mask = rounded_mask(track.size, 70 * S)
inner.paste(track, (track_box[0], track_box[1]), track_mask)
# track inner top highlight + border
d = ImageDraw.Draw(inner)
d.rounded_rectangle(track_box, radius=70 * S, outline=(255, 255, 255, 26), width=2 * S)

# --- knob (right side, "on") ---
knob_cx = track_box[2] - 76 * S
knob_cy = (track_box[1] + track_box[3]) // 2
knob_r = 52 * S
# knob glow
kg = radial_glow((BASE, BASE), (knob_cx, knob_cy), 78 * S, (158, 226, 47), 150)
inner.alpha_composite(kg)
# knob body with radial-ish gradient (light top-left -> deep green)
knob = Image.new('RGBA', (2 * knob_r, 2 * knob_r), (0, 0, 0, 0))
kd = ImageDraw.Draw(knob)
for i in range(2 * knob_r, 0, -1):
    t = i / (2 * knob_r)
    # interpolate (191,232,72) -> (96,151,0)
    col = tuple(int(96 + (191 - 96) * (1 - t) ** 0.8) for _ in range(0)) # placeholder
# simpler: fill + highlight
kd.ellipse([0, 0, 2 * knob_r - 1, 2 * knob_r - 1], fill=(127, 199, 16, 255))
hi = Image.new('RGBA', knob.size, (0, 0, 0, 0))
hd = ImageDraw.Draw(hi)
hd.ellipse([-knob_r * 0.5, -knob_r * 0.55, knob_r * 1.25, knob_r * 0.95], fill=(200, 245, 110, 120))
hi = hi.filter(ImageFilter.GaussianBlur(knob_r * 0.22))
knob.alpha_composite(hi)
km = rounded_mask(knob.size, knob_r)  # circular mask
# circular mask: draw ellipse instead
km = Image.new('L', knob.size, 0)
ImageDraw.Draw(km).ellipse([0, 0, 2 * knob_r - 1, 2 * knob_r - 1], fill=255)
inner.paste(knob, (knob_cx - knob_r, knob_cy - knob_r), km)
d.ellipse([knob_cx - knob_r, knob_cy - knob_r, knob_cx + knob_r, knob_cy + knob_r],
          outline=(255, 255, 255, 70), width=2 * S)

# --- lightning bolt inside knob ---
bolt_pts_base = [(58, 8), (34, 62), (52, 62), (42, 104), (78, 50), (58, 50), (72, 8)]
scale = 0.62
pts = [(knob_cx - 60 * S + x * 0.62 * scale * S, knob_cy - 56 * S + y * 0.62 * scale * S) for (x, y) in bolt_pts_base]
# normalize around knob center
xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
bcx, bcy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
pts = [(x + (knob_cx - bcx), y + (knob_cy - bcy)) for x, y in pts]
d.polygon(pts, fill=(14, 30, 2, 255))

# --- left "ghost" indicator dots on track (off side) ---
for i in range(3):
    x = track_box[0] + (44 + i * 26) * S
    y = knob_cy
    r = 6 * S
    a = 80 - i * 22
    d.ellipse([x - r, y - r, x + r, y + r], fill=(158, 226, 47, a))

# --- tile border ---
d.rounded_rectangle([S, S, BASE - S, BASE - S], radius=RADIUS - S, outline=(255, 255, 255, 22), width=3 * S)

canvas.alpha_composite(inner)

# downscale to 512 and export
final = canvas.resize((512, 512), Image.LANCZOS)
os.makedirs(OUT, exist_ok=True)
final.save(os.path.join(OUT, 'icon.png'))

# .ico with full size ladder
sizes = [16, 24, 32, 48, 64, 128, 256]
final.save(os.path.join(OUT, 'icon.ico'), sizes=[(s, s) for s in sizes])
print('icon.ico + icon.png written to', os.path.abspath(OUT))
