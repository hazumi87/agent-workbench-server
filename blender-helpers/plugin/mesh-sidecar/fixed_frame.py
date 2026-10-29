"""fixed_frame.py -- explicit FIXED-FRAME conditioning for Hunyuan3D-2mv (no per-view auto-crop).

Why: the stock MVImageProcessorV2 crops every view to the bounding box of its non-zero alpha and rescales that box to 85% of the
square (per view!). Views of one part therefore get different scales, and a broad, short part (shoulders wider than tall) is scaled by its
WIDTH. Here the caller frames the views; this module only (1) checks that they share one square frame, (2) composites on white and resizes
the WHOLE frame to the model size with the same interpolation as the stock path (cubic for colour, nearest for mask), (3) writes the exact
conditioning inputs and a framing record. Nothing is cropped, recentred or rescaled relative to the frame.

Pieces
  load_views / check_frames      read cut_<view>.png, refuse mixed or non-square frames (or --pad: centre-pad with transparency, never scale)
  composite_view                 RGBA frame -> (size x size x 3 uint8 on white, size x size mask)   [numpy + cv2 only, no torch]
  framing_record / write_debug   conditioning_<view>.png (the exact 512 px image the model is fed), conditioning_<view>_mask.png,
                                 framing.json (per-view: file sha256, frame px, alpha box in frame px and as a fraction, centre offset,
                                 px-per-conditioning-px, background, interpolation, pad), debug_montage.png (a review aid, NEVER an input)
  FixedFrameMVProcessor          drop-in for pipe.image_processor (same output dict: image, mask, view_idxs sorted front,left,back,right)
CLI (dry run, no GPU, no model):  python fixed_frame.py --views DIR --out DIR [--part NAME] [--meta meta.json] [--pad]
"""
import argparse, hashlib, json, os, sys
import numpy as np

VIEWS = ('front', 'left', 'back', 'right')
VIEW2IDX = {'front': 0, 'left': 1, 'back': 2, 'right': 3}
INTERP = {'colour': 'cv2.INTER_CUBIC', 'mask': 'cv2.INTER_NEAREST', 'background': 'white (255,255,255)', 'order': 'alpha-composite first, then resize the whole frame'}


def _cv2():
    import cv2
    return cv2


def sha256_file(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def load_views(src, name=lambda v: f'cut_{v}.png'):
    """{view: PIL RGBA} for the views present in src (front required), plus {view: path}."""
    from PIL import Image
    imgs, paths = {}, {}
    for v in VIEWS:
        p = os.path.join(src, name(v))
        if os.path.exists(p):
            imgs[v] = Image.open(p).convert('RGBA'); paths[v] = p
    if 'front' not in imgs:
        raise FileNotFoundError(f'no front view in {src}')
    return imgs, paths


def pad_to_square(img, side):
    """Centre-pad (transparent) to side x side. Never scales. Returns (image, (left, top))."""
    from PIL import Image
    w, h = img.size
    if w > side or h > side:
        raise ValueError(f'image {w}x{h} is larger than the frame {side}')
    out = Image.new('RGBA', (side, side), (255, 255, 255, 0)); l, t = (side - w) // 2, (side - h) // 2; out.paste(img, (l, t)); return out, (l, t)


def check_frames(imgs, pad=False):
    """One common square frame for all views. Returns (imgs, frame_px, pads). Raises ValueError listing every problem when not consistent
    (unless pad=True, which centre-pads every view to the largest side without scaling)."""
    sizes = {v: im.size for v, im in imgs.items()}; probs = []
    side = max(max(s) for s in sizes.values())
    if not pad:
        for v, (w, h) in sizes.items():
            if w != h: probs.append(f'{v}: {w}x{h} is not square')
        if len({s for s in sizes.values()}) > 1: probs.append(f'views differ in size: {sizes}')
        if probs: raise ValueError('; '.join(probs) + ' (frame the views to one square, or pass pad=True to centre-pad without scaling)')
        return dict(imgs), side, {v: (0, 0) for v in imgs}
    out, pads = {}, {}
    for v, im in imgs.items(): out[v], pads[v] = pad_to_square(im, side)
    return out, side, pads


def composite_view(img, size=512, bg=255):
    """RGBA frame -> (rgb uint8 [size,size,3] on bg, mask uint8 [size,size]); the same interpolation as the stock path, but NO crop/recentre."""
    cv2 = _cv2(); a = np.asarray(img.convert('RGBA')); m = a[..., 3:4].astype(np.float32) / 255
    rgb = (a[..., :3].astype(np.float32) * m + bg * (1 - m)).clip(0, 255).astype(np.uint8)
    rgb = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_CUBIC); mask = cv2.resize(a[..., 3], (size, size), interpolation=cv2.INTER_NEAREST)
    return rgb, mask


def alpha_box(img):
    a = np.asarray(img.convert('RGBA'))[..., 3]; ys, xs = np.nonzero(a)
    if not len(xs): raise ValueError('empty alpha')
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1   # x0, y0, x1(excl), y1(excl) in frame px


def framing_record(imgs, paths=None, frame_px=None, pads=None, size=512, meta=None):
    rec = {'tool': 'fixed_frame.py v1', 'frame_px': frame_px, 'conditioning_px': size, 'frame_to_conditioning_scale': size / frame_px, 'stock_preprocessing_replaced': 'recenter (crop to alpha box, scale to 85% of the square, per view)',
           'interpolation': INTERP, 'views': {}, 'meta': meta or {}}
    heights = []
    for v in VIEWS:
        if v not in imgs: continue
        x0, y0, x1, y1 = alpha_box(imgs[v]); w, h = x1 - x0, y1 - y0; heights.append(h)
        r = {'frame_size': list(imgs[v].size), 'alpha_box_frame_px': [x0, y0, x1, y1], 'box_w_px': w, 'box_h_px': h, 'box_h_fraction': round(h / frame_px, 4), 'box_w_fraction': round(w / frame_px, 4),
             'box_centre_offset_from_frame_centre_px': [round((x0 + x1) / 2 - frame_px / 2, 1), round((y0 + y1) / 2 - frame_px / 2, 1)], 'view_slot': VIEW2IDX[v], 'pad_applied_px': list((pads or {}).get(v, (0, 0)))}
        if paths and v in paths: r['file'] = os.path.basename(paths[v]); r['file_sha256'] = sha256_file(paths[v])
        warn = []
        if min(x0, y0, frame_px - x1, frame_px - y1) < 4: warn.append('object touches/near the frame edge (<4 px)')
        if h / frame_px < 0.3: warn.append('object fills <30% of the frame height')
        if warn: r['warnings'] = warn
        rec['views'][v] = r
    if heights: rec['box_height_spread_px'] = max(heights) - min(heights); rec['box_height_spread_fraction'] = round((max(heights) - min(heights)) / frame_px, 4)
    return rec


def write_debug(out, imgs, paths=None, frame_px=None, pads=None, size=512, meta=None, tag='conditioning'):
    """The exact conditioning inputs and the framing record. Returns the record. Montage is a REVIEW AID only (never an input)."""
    from PIL import Image
    os.makedirs(out, exist_ok=True); rec = framing_record(imgs, paths, frame_px, pads, size, meta); tiles = []
    for v in VIEWS:
        if v not in imgs: continue
        rgb, mask = composite_view(imgs[v], size); Image.fromarray(rgb).save(os.path.join(out, f'{tag}_{v}.png')); Image.fromarray(mask).save(os.path.join(out, f'{tag}_{v}_mask.png'))
        rec['views'][v]['conditioning_png'] = f'{tag}_{v}.png'; rec['views'][v]['conditioning_rgb_sha256'] = hashlib.sha256(rgb.tobytes()).hexdigest(); tiles.append(rgb)
    if tiles:
        m = np.concatenate(tiles, 1); Image.fromarray(m).save(os.path.join(out, 'debug_montage_NOT_AN_INPUT.png'))
    json.dump(rec, open(os.path.join(out, 'framing.json'), 'w'), indent=1)
    return rec


class FixedFrameMVProcessor:
    """Drop-in for pipe.image_processor (MVImageProcessorV2 interface). Takes {'front': PIL RGBA, ...} already framed to ONE square."""
    return_view_idx = True

    def __init__(self, size=512, pad=False, debug_dir=None, meta=None):
        self.size, self.pad, self.debug_dir, self.meta = size, pad, debug_dir, meta; self.last = None

    def __call__(self, image_dict, border_ratio=None, to_tensor=True, **kw):
        imgs, frame_px, pads = check_frames({k: v.convert('RGBA') for k, v in image_dict.items()}, pad=self.pad)
        order = sorted(imgs, key=lambda v: VIEW2IDX[v]); arrs = {v: composite_view(imgs[v], self.size) for v in order}
        self.last = {'frame_px': frame_px, 'views': order, 'rgb': {v: arrs[v][0] for v in order}, 'mask': {v: arrs[v][1] for v in order}}
        if self.debug_dir: write_debug(self.debug_dir, imgs, None, frame_px, pads, self.size, self.meta, tag='fed')
        if not to_tensor:
            return {'image': [arrs[v][0] for v in order], 'mask': [arrs[v][1] for v in order], 'view_idxs': tuple(VIEW2IDX[v] for v in order)}
        import torch
        from hy3dgen.shapegen.preprocessors import array_to_tensor
        images = [array_to_tensor(arrs[v][0]) for v in order]; masks = [array_to_tensor(arrs[v][1][..., None]) for v in order]
        return {'image': torch.cat(images, 0).unsqueeze(0), 'mask': torch.cat(masks, 0).unsqueeze(0), 'view_idxs': tuple(VIEW2IDX[v] for v in order)}


def main():
    ap = argparse.ArgumentParser(description='dry run: check the frame and write the conditioning inputs + framing.json (no model, no GPU)')
    ap.add_argument('--views', required=True); ap.add_argument('--out', required=True); ap.add_argument('--part', default=''); ap.add_argument('--meta', help='JSON file merged into framing.json meta (source id, crop box, anchors...)'); ap.add_argument('--pad', action='store_true'); ap.add_argument('--size', type=int, default=512)
    a = ap.parse_args(); imgs, paths = load_views(a.views); imgs, frame_px, pads = check_frames(imgs, pad=a.pad)
    meta = {'part': a.part}; meta.update(json.load(open(a.meta)) if a.meta else {})
    rec = write_debug(a.out, imgs, paths, frame_px, pads, a.size, meta); print(json.dumps({'frame_px': frame_px, 'views': {v: (r['box_w_px'], r['box_h_px'], r.get('warnings')) for v, r in rec['views'].items()}, 'box_height_spread_px': rec.get('box_height_spread_px')}))


if __name__ == '__main__':
    main()
