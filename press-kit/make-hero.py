"""Hue-shift the original artwork — NOT a duotone.

The duotone approach mapped luminance onto a single colour ramp, which threw
away every colour relationship in the photograph and left it looking like an
overlay. This rotates hue in HSV and leaves saturation and value alone, so
the original tonality, depth and colour variation all survive; only the hue
moves. The dominant hue is measured per image, so each one lands on the same
target green regardless of what colour it started as.
"""
from PIL import Image, ImageOps
import numpy as np, colorsys, os, sys
Image.MAX_IMAGE_PIXELS = None

SRC = '/Users/morphics/Desktop/MorphicsBrain/Morphics Web/Artwork : Photography'
OUT = 'public/images/press/hero'
TARGET_HUE = 140/360          # where his artwork's real greens sit

def dominant_hue(hsv, sat_min=0.25, val_min=0.15):
    h, s, v = hsv[...,0], hsv[...,1], hsv[...,2]
    m = (s > sat_min) & (v > val_min)
    if m.sum() < 100: return None
    # Circular mean — averaging hue linearly breaks across the 0/1 wrap.
    ang = h[m] * 2*np.pi
    return (np.arctan2(np.sin(ang).mean(), np.cos(ang).mean()) / (2*np.pi)) % 1.0

def rgb_to_hsv_np(a):
    r,g,b = a[...,0], a[...,1], a[...,2]
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    idx = nz & (mx == r); h[idx] = ((g-b)[idx]/d[idx]) % 6
    idx = nz & (mx == g); h[idx] = ((b-r)[idx]/d[idx]) + 2
    idx = nz & (mx == b); h[idx] = ((r-g)[idx]/d[idx]) + 4
    h = h/6
    s = np.where(mx > 1e-6, d/np.maximum(mx,1e-6), 0)
    return np.stack([h, s, mx], -1)

def hsv_to_rgb_np(a):
    h,s,v = a[...,0], a[...,1], a[...,2]
    i = np.floor(h*6).astype(int) % 6
    f = h*6 - np.floor(h*6)
    p, q, t = v*(1-s), v*(1-f*s), v*(1-(1-f)*s)
    out = np.zeros(a.shape)
    for k,(R,G,B) in enumerate([(v,t,p),(q,v,p),(p,v,t),(p,q,v),(t,p,v),(v,p,q)]):
        m = i == k
        out[...,0][m], out[...,1][m], out[...,2][m] = R[m], G[m], B[m]
    return out

def hue_shift(src, out, target=TARGET_HUE, sat=1.0, width=2600):
    im = ImageOps.exif_transpose(Image.open(os.path.join(SRC, src))).convert('RGB')
    im.thumbnail((width,width), Image.LANCZOS)
    a = np.asarray(im, dtype=float)/255
    hsv = rgb_to_hsv_np(a)
    dom = dominant_hue(hsv)
    if dom is None: dom = 0.0
    shift = (target - dom) % 1.0
    hsv[...,0] = (hsv[...,0] + shift) % 1.0
    if sat != 1.0:
        hsv[...,1] = np.clip(hsv[...,1]*sat, 0, 1)
    rgb = (hsv_to_rgb_np(hsv)*255).clip(0,255).astype(np.uint8)
    Image.fromarray(rgb).save(out, quality=90, optimize=True, progressive=True)
    return im.size, dom*360, shift*360

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    frames = {
      'h1-stack3':    'stack 3 copy.jpg',
      'h2-slime':     'SLIME STACK00108702 copy.jpg',
      'h3-timeline3': 'Timeline 3_00108005 copy 2.jpg',
      'h4-dscf3354':  'DSCF3354 copy.JPG',
      'h5-stack8':    'Stack 8 copy 2.jpg',
      'h6-blue':      'BLUE STACK00108217 copy.jpg',
      'h7-molten':    'MOLTEN STACK00108883 copy.jpg',
      'h8-timeline1': 'Timeline 1_00108037 copy.jpg',
      'h9-dscf3342':  'DSCF3342 copy.JPG',
      'h10-portal':   'PORTAL INSTA00108152 copy.jpg',
    }
    for k, f in frames.items():
        try:
            size, dom, sh = hue_shift(f, f'{OUT}/{k}.jpg')
            print(f'  {k:14} {str(size):14} original hue {dom:5.0f}° -> rotated {sh:5.0f}°')
        except Exception as e:
            print(f'  {k:14} FAILED: {e}')
