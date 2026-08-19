"""Three silhouettes: the archway mirrored either side of the decks shot.

Reads as curtains being pulled open with him stepping through the middle.
The archway frame is cut at 0.224 — measured, where the wall ends and the
opening begins — and that same cut is mirrored on the left so the two arches
face each other. Hard butt joins, no feathering.
"""
from PIL import Image, ImageOps
import sys, os

H = 900
LOGO = 'public/images/press/morphics-live-logo.jpg'
ARCH = 'public/images/press/morphics-silhouette.jpg'
CUT_L, CUT_R = 0.224, 0.88          # where the opening starts / ends
# Trim off the top band: blown-out sky in the archway frames and the dark
# stage rigging above the screen in the decks frame. It carried no subject
# and the brightness at the very top pulled the eye away from the figures.
TOP_CROP = 0.14

def gray(p):
    return ImageOps.exif_transpose(Image.open(p)).convert('L').convert('RGB')

def build(out, arch_w_frac=1.0, mirror=True):
    logo, arch = gray(LOGO), gray(ARCH)
    # Crop the top band off BOTH sources before scaling, so the trim is
    # proportional and the three panels stay aligned.
    for name in ('logo', 'arch'):
        pass
    logo = logo.crop((0, int(logo.height * TOP_CROP), logo.width, logo.height))
    arch = arch.crop((0, int(arch.height * TOP_CROP), arch.width, arch.height))
    logo = logo.resize((int(logo.width * H / logo.height), H), Image.LANCZOS)
    arch = arch.resize((int(arch.width * H / arch.height), H), Image.LANCZOS)
    arch = arch.crop((int(arch.width * CUT_L), 0, int(arch.width * CUT_R), H))
    if arch_w_frac != 1.0:                      # trim the outer edge if asked
        arch = arch.crop((0, 0, int(arch.width * arch_w_frac), H))

    if mirror:
        parts = [arch, logo, ImageOps.mirror(arch)]   # both figures face inward
    else:
        parts = [logo, ImageOps.mirror(arch)]
    W = sum(p.width for p in parts)
    canvas = Image.new('RGB', (W, H), (0, 0, 0))
    x = 0
    for p in parts:
        canvas.paste(p, (x, 0)); x += p.width
    canvas.save(out, quality=88, optimize=True, progressive=True)
    return canvas.size

if __name__ == '__main__':
    two   = build('public/images/press/morphics-composite-2up.jpg', mirror=False)
    three = build('public/images/press/morphics-composite.jpg', mirror=True)
    print(f'  two silhouettes:   {two}')
    print(f'  three (mirrored):  {three}   <- curtains open, stepping through')
