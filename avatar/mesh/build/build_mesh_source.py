import json, subprocess, sys, shutil, os
import numpy as np
from PIL import Image

L = r"C:\Users\User\Desktop\virtual-assistant\avatar\layers\\"
m = json.load(open(L + "layers.json", encoding="utf8"))
W, H = m["canvas"]["width"], m["canvas"]["height"]

# 1. mesh source: no tails, no ears, no mouth (the mouth is drawn as its own scaled sprite)
out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
for l in m["layers"]:
    f = l["file"]
    if f.startswith("tail") or f.startswith("ears") or f == "mouth.png":
        continue
    im = Image.open(L + f).convert("RGBA")
    c = Image.new("RGBA", (W, H), (0, 0, 0, 0)); c.paste(im, (l.get("x", 0), l.get("y", 0)))
    out = Image.alpha_composite(out, c)
a = np.array(out)
a[(a[:, :, 3] > 0) & (a[:, :, 3] < 24)] = 0
Image.fromarray(a, "RGBA").save("input/shiro_mesh_nomouth.png")
print("source ok")

# 2. rig: nose region covers the whole highlight; mouth area a bit larger for the sprite
rig = json.load(open("projects/shiro/rig.draft.json"))
rig["face"]["nose"] = {"cx": 640, "cy": 592, "rx": 52, "ry": 34}
rig["mouth"]["area"] = {"cx": 642, "cy": 692, "rx": 62, "ry": 38, "angle": 0.0}
os.makedirs("projects/shiromo_draft", exist_ok=True)
json.dump(rig, open("projects/shiromo_draft/rig.draft.json", "w"), indent=2)

# 3. the mouth sprite: the layered avatar's own mouth drawing, cropped with a margin
mouth = np.array(Image.open(L + "mouth.png").convert("RGBA"))
ys, xs = np.where(mouth[:, :, 3] > 20)
pad = 8
x0, x1, y0, y1 = xs.min() - pad, xs.max() + pad + 1, ys.min() - pad, ys.max() + pad + 1
crop = Image.fromarray(mouth[y0:y1, x0:x1], "RGBA")
os.makedirs("work/mouth_sprite", exist_ok=True)
crop.save("work/mouth_sprite/mouth_a.png")
json.dump({"rect": [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]}, open("work/mouth_sprite/rect.json", "w"))
print("mouth sprite rect", [int(x0), int(y0), int(x1 - x0), int(y1 - y0)])
