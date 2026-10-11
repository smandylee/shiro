import json
import numpy as np, cv2
from PIL import Image

import sys
P = sys.argv[1] if len(sys.argv) > 1 else "projects/shiro/"
src = np.array(Image.open(P + "source.png").convert("RGBA"))
mask = np.array(Image.open(P + "variant-requests/eyes_smile/mask.png").convert("RGBA"))[:, :, 3]
rig = json.load(open(P + "rig.json"))
editable = (mask < 128).astype(np.uint8)
# keep every change >= 4 px inside the editable region
safe = cv2.erode(editable, np.ones((9, 9), np.uint8)) > 0

L = r"C:\Users\User\Desktop\virtual-assistant\avatar\layers\\"
def lay(n): return np.array(Image.open(L + n).convert("RGBA"))[:, :, 3] > 20
parts = {
    0: ["eyewhite-r.png", "irides-r.png", "eyelash-r.png"],
    1: ["eyewhite-l.png", "irides-l.png", "eyelash-l.png"],
}
erase = np.zeros(src.shape[:2], np.uint8)
for names in parts.values():
    for n in names: erase |= lay(n).astype(np.uint8)
erase = cv2.dilate(erase, np.ones((7, 7), np.uint8))
erase = (erase > 0) & safe

rgb = np.ascontiguousarray(src[:, :, :3])
H0, W0 = src.shape[:2]
hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
sat, val = hsv[:, :, 1], hsv[:, :, 2]
k = lambda n: np.ones((n, n), np.uint8)
near = cv2.dilate(erase.astype(np.uint8), k(29)) > 0
# lash / crease remnants: dark and coloured (hair outlines are grey, so they stay)
remnant = near & (val < 185) & (sat > 55)
region = cv2.dilate((erase | (remnant & safe)).astype(np.uint8), k(5)) > 0
region &= safe
# Fill from a smooth skin-colour field built only from clean skin pixels (pink, bright,
# outside the patch): a normalised blur, so dark outlines and hair never leak in, and the
# blush shading carries through.
clean = (sat > 35) & (sat < 140) & (val > 185) & ~(cv2.dilate(region.astype(np.uint8), k(3)) > 0)
cw = clean.astype(np.float32)
field = np.tile(np.median(rgb[clean], axis=0).astype(np.float32), (H0, W0, 1))
for sigma in (60, 30, 14, 7):   # wide first, then local detail wherever skin is within reach
    num = cv2.GaussianBlur(rgb.astype(np.float32) * cw[:, :, None], (0, 0), sigma)
    den = cv2.GaussianBlur(cw, (0, 0), sigma)[:, :, None]
    field = np.where(den > 0.08, num / np.maximum(den, 1e-3), field)
soft = cv2.GaussianBlur(region.astype(np.float32), (0, 0), 1.5) * safe
out = rgb.astype(np.float32) * (1 - soft[:, :, None]) + field * soft[:, :, None]
out = np.clip(out, 0, 255).astype(np.uint8)

# --- draw the smiling arcs on a 4x supersampled layer
S = 4
H, W = src.shape[:2]
ink = np.zeros((H * S, W * S), np.float32)
LASH = np.array([58, 34, 36], np.float32)
def bez(p0, p1, p2, n=80):
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2
for e in rig["eyes"]:
    pts = np.array(e["opening"], np.float32)
    x0, x1 = pts[:, 0].min(), pts[:, 0].max()
    cy = float(pts[:, 1].mean())
    wdt = x1 - x0
    # slight inset so the arc sits inside the old eye, corners a touch lower than the middle
    a = np.array([x0 + wdt * 0.04, cy + wdt * 0.10]); b = np.array([x1 - wdt * 0.04, cy + wdt * 0.10])
    c = np.array([(x0 + x1) / 2, cy - wdt * 0.30])
    curve = bez(a, c, b)
    for i, (x, y) in enumerate(curve):
        t = i / (len(curve) - 1)
        thick = 2.0 + 4.2 * np.sin(np.pi * t) ** 0.8   # thin at both corners, heaviest mid-arc
        cv2.circle(ink, (int(x * S), int(y * S)), max(1, int(thick * S / 2)), 1.0, -1, cv2.LINE_AA)
ink = cv2.resize(ink, (W, H), interpolation=cv2.INTER_AREA)
ink = np.clip(ink, 0, 1) * (safe.astype(np.float32))
a3 = ink[:, :, None]
out = (out.astype(np.float32) * (1 - a3) + LASH * a3).astype(np.uint8)

res = src.copy()
res[:, :, :3] = np.where(safe[:, :, None], out, src[:, :, :3])
Image.fromarray(res, "RGBA").save(P + "variants/eyes_smile.png")
chk = np.abs(res.astype(int) - src.astype(int)).sum(axis=2) > 0
print("changed px", int(chk.sum()), "outside editable", int((chk & (editable == 0)).sum()))
Image.fromarray(res).crop((380, 440, 900, 640)).resize((1040, 400), Image.LANCZOS).save("work/smile_crop.png")
