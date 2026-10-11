import json, math
import numpy as np, cv2
from PIL import Image
R = r"C:\Users\User\Desktop\virtual-assistant\avatar\layers\\"
P = "projects/shiro/rig.draft.json"
rig = json.load(open(P))

def mask(name):
    return np.array(Image.open(R + name).convert("RGBA"))[:, :, 3] > 20

def poly_from(m, n, outer_is_left, hull=False):
    m8 = (m.astype(np.uint8)) * 255
    cs, _ = cv2.findContours(m8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    if hull: c = cv2.convexHull(c)
    eps = 0.5
    while True:
        a = cv2.approxPolyDP(c, eps, True)[:, 0, :]
        if len(a) <= n: break
        eps += 0.3
    pts = [[int(x), int(y)] for x, y in a]
    xs = [p[0] for p in pts]
    i = xs.index(min(xs) if outer_is_left else max(xs))
    return pts[i:] + pts[:i]

def eye(white, iris, lash, outer_is_left):
    op = mask(white) | mask(iris)
    # keep only the eye's own area, drop stray pixels far away
    roi = (mask(white) | mask(iris) | mask(lash)).astype(np.uint8)
    roi = cv2.dilate(roi, np.ones((9, 9), np.uint8)) > 0
    return {"opening": poly_from(op, 18, outer_is_left), "roi": poly_from(roi, 14, outer_is_left, hull=True)}

rig["eyes"] = [
    eye("eyewhite-r.png", "irides-r.png", "eyelash-r.png", True),   # image-left eye
    eye("eyewhite-l.png", "irides-l.png", "eyelash-l.png", False),  # image-right eye
]

def ell(cx, cy, rx, ry): return {"cx": cx, "cy": cy, "rx": rx, "ry": ry}
rig["head"].update({"cx": 640, "cy": 390, "rx": 400, "ry": 400, "shiftX": 51, "shiftY": 32,
                    "pivotX": 640, "pivotY": 780, "maxRoll": 0.15,
                    "weightBand": [790, 900], "turnBand": [790, 960]})
rig["body"].update({"pivotX": 640, "pivotY": 1279, "maxRoll": 0.035,
                    "breathBand": [900, 1280], "rollBand": [800, 1280],
                    "chest": ell(640, 1010, 330, 250),
                    "shoulders": [ell(310, 890, 110, 90), ell(970, 890, 110, 90)]})
f = rig["face"]
f["nose"] = ell(640, 592, 30, 22)
f["mouth"] = ell(642, 693, 50, 30)
f["eyeA"] = ell(511, 543, 75, 55)
f["eyeB"] = ell(772, 545, 80, 55)
f["earL"] = ell(390, 140, 130, 160)
f["earR"] = ell(885, 150, 150, 160)
f["brow"] = {**ell(640, 445, 210, 30), "band": [400, 480]}
f["jaw"] = {**ell(640, 735, 150, 70), "band": [690, 790]}
rig["buns"] = None
rig.pop("buns")
rig["mouth"] = {"cx": 642, "cy": 692, "angle": 0.0, "halfLen": 36, "bow": 0,
                "area": {"cx": 642, "cy": 692, "rx": 52, "ry": 32, "angle": 0.0}}
rig["cheeks"] = [[505, 628], [775, 625]]
def strand(name, nodes, sigma=20, k=1.0, mx=9): return {"name": name, "nodes": nodes, "sigma": sigma, "k": k, "max": mx}
rig["strands"] = [
    strand("bang1", [[600, 150], [585, 260], [575, 360], [570, 450]]),
    strand("bang2", [[650, 150], [645, 260], [640, 360], [630, 450]], k=0.92),
    strand("bang3", [[710, 150], [725, 260], [730, 360], [735, 440]], k=0.95),
    strand("sideL1", [[400, 430], [380, 540], [375, 640], [385, 730]], mx=11),
    strand("sideL2", [[440, 440], [430, 560], [440, 660], [470, 730]], mx=10),
    strand("sideR1", [[880, 430], [900, 540], [905, 640], [895, 730]], mx=11),
    strand("sideR2", [[870, 440], [880, 560], [875, 660], [860, 730]], mx=10),
]
rig.pop("accessories", None); rig.pop("hand", None)
rig["mesh"].update({"baseCell": 14, "fine": {"x0": 260, "x1": 1040, "y0": 0, "y1": 800, "cell": 7},
                    "handCell": 9, "tasselCell": 6, "eyeBallCell": 4, "eyeCell": 3, "spriteCell": 4})
rig["view"] = {"padTop": -0.07, "padSide": 0, "gazeCenter": [640, 540]}
json.dump(rig, open(P, "w"), indent=2)
print("eyes open pts", [len(e["opening"]) for e in rig["eyes"]], "roi", [len(e["roi"]) for e in rig["eyes"]])
print([rig["eyes"][0]["opening"][0], rig["eyes"][1]["opening"][0]])
