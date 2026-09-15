# Checks every sweep photo, both themes: holes (page background inside the silhouette in the
# neck band), doubled fur below the collar cut, and a second face (white cap/fur area above the
# collar grows past the resting amount, which is what a static head peeking out looks like).
import json, sys
from PIL import Image, ImageFilter
import numpy as np
out = sys.argv[1]
# The alpha reference is an argument now: in the preview it sat at mascot/fox.png beside the
# runner, and in the app it ships under public/.
alpha_src = sys.argv[2] if len(sys.argv) > 2 else "public/mascot/fox.png"
rep = json.load(open(f"{out}/report.json"))
BG = {"paper": (255, 0, 255), "ink": (255, 0, 255)}   # the sweep paints the ground magenta
alpha900 = Image.open(alpha_src).convert("RGBA").split()[3]
def masks(w):
    s = w / 900
    core = np.array(alpha900.resize((w, w)).filter(ImageFilter.MinFilter(int(25 * s) | 1))) > 250
    return s, core
rows = []; bad = 0; rest_white = {}
for r in rep["report"]:
    im = np.array(Image.open(f"{out}/{r['file']}").convert("RGB")).astype(int); w = min(im.shape[0], im.shape[1]); im = im[:w, :w]
    s, core = masks(w); bg = np.array(BG[r["theme"]])
    y0, y1, x0, x1 = int(355*s), int(395*s), int(335*s), int(595*s)
    band = im[y0:y1, x0:x1]; m = core[y0:y1, x0:x1]
    hole = int((((abs(band - bg) < 14).all(axis=2)) & m).sum())
    y2, y3 = int(400*s), int(440*s); below = im[y2:y3, x0:x1]; m2 = core[y2:y3, x0:x1]   # 12 px below the collar cut: the chin fur reaches 394 at full down-tilt and is not a second face
    white = int((((below > 225).all(axis=2)) & m2).sum())
    face = im[int(20*s):int(340*s), int(120*s):int(780*s)]
    whitearea = int(((face > 228).all(axis=2)).sum())           # cap + white fur, anywhere above the collar
    key = (r["vp"], r["theme"]); rest = rest_white.setdefault(key, whitearea) if r["x"] == round(int(r["vp"].split("x")[0]) * 0.5) and r["y"] == round(int(r["vp"].split("x")[1]) * 0.5) else rest_white.get(key)
    # shoulder line: nothing dark may appear OUTSIDE the resting silhouette (dilated 6 px) in the collar rows
    dil = np.array(alpha900.resize((w, w)).filter(ImageFilter.MaxFilter(int(25 * s) | 1))) > 5     # 12 px: the body itself leans up to ~10 px; a protruding collar copy would exceed this
    ys0, ys1 = int(325*s), int(400*s); outside = ~dil[ys0:ys1]; strip = im[ys0:ys1]
    # the blindfold's tails legitimately hang outside the head on the RIGHT down to ~y 350 at full turn; judge the
    # right shoulder from y 362 and the left shoulder over the whole band
    tails = np.zeros_like(outside); tails[: int(362*s) - ys0, int(560*s):] = True
    dark = int((((strip < 90).all(axis=2)) & outside & ~tails).sum())
    rows.append([r, hole, white, whitearea, dark])
for row in rows:
    r, hole, white, whitearea, dark = row; key = (r["vp"], r["theme"]); rest = rest_white.get(key, whitearea)
    double = whitearea > rest * 1.12
    ok = hole <= 8 and white <= 8 and not double and dark <= 8
    bad += 0 if ok else 1
    print("%-9s %-5s (%4d,%4d) hole=%-4d white=%-4d dark=%-4d whitearea=%-6d rest=%-6d %s" % (r["vp"], r["theme"], r["x"], r["y"], hole, white, dark, whitearea, rest, "ok" if ok else "FAIL"))
print("errors:", rep["errors"]); print("shots:", len(rows), "failing:", bad)
# A SHORT SWEEP MUST NOT READ AS A CLEAN ONE. This checker analyses whatever it is handed,
# so six shots with no holes in them printed "failing: 0" and exited 0 - a green that says
# nothing about the 48 viewport/theme/pointer combinations nobody photographed. The sweep
# writes what it intended to take and this refuses to pass on fewer. (Added in the port to
# the repo; the preview's own copy had the same hole.)
expected = rep.get("expected")
if expected is not None and len(rows) != expected:
    print("FAIL: analysed", len(rows), "shots but the sweep intended", expected)
    sys.exit(1)
if expected is None:
    print("FAIL: report.json carries no expected count, so this run cannot be judged complete")
    sys.exit(1)
files = [r["file"] for r in rep["report"]]; ims = [Image.open(f"{out}/{f}").convert("RGB").resize((220, 220)) for f in files]
cols = 9; rws = (len(ims) + cols - 1) // cols; sheet = Image.new("RGB", (cols * 220, rws * 220), (128, 128, 128))
for i, im in enumerate(ims): sheet.paste(im, ((i % cols) * 220, (i // cols) * 220))
sheet.save(f"{out}/contact-sheet.png"); print("sheet:", f"{out}/contact-sheet.png")
sys.exit(1 if bad or rep["errors"] else 0)
