"""test_fixed_frame.py -- python test_fixed_frame.py   (GPU host venv; numpy, cv2, PIL, and torch + hy3dgen for the processor comparison; no GPU use, no model).
Synthetic views: one square frame, boxes of DIFFERENT heights per view. Checks: frame refusal rules, pad never scales, exact pixel mapping, debug outputs + framing.json,
the processor's output dict and view order, and the difference from the stock per-view recentre."""
import json, os, sys, tempfile
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fixed_frame as ff

def mk(side, box, col):
    a = np.zeros((side, side, 4), np.uint8); x0, y0, x1, y1 = box; a[y0:y1, x0:x1] = (*col, 255); return Image.fromarray(a)
S = 1000
views = {'front': mk(S, (300, 100, 700, 900), (200, 30, 30)), 'left': mk(S, (380, 140, 620, 860), (30, 200, 30)), 'back': mk(S, (300, 120, 700, 880), (30, 30, 200)), 'right': mk(S, (380, 100, 620, 900), (200, 200, 30))}
ok = 0
def check(name, cond):
    global ok; print(('PASS ' if cond else 'FAIL ') + name); ok += 0 if cond else 1
imgs, frame, pads = ff.check_frames(views); check('equal square frames accepted', frame == S and all(p == (0, 0) for p in pads.values()))
try: ff.check_frames({**views, 'left': mk(900, (300, 100, 600, 800), (1, 2, 3))}); check('mixed sizes refused', False)
except ValueError as e: check('mixed sizes refused', 'differ' in str(e))
try: ff.check_frames({**views, 'left': Image.new('RGBA', (900, 1000))}); check('non-square refused', False)
except ValueError as e: check('non-square refused', 'not square' in str(e))
pi, pf, pp = ff.check_frames({**views, 'left': mk(900, (300, 100, 600, 800), (9, 9, 9))}, pad=True); check('pad: common frame = largest side, no scaling', pf == S and pi['left'].size == (S, S) and ff.alpha_box(pi['left'])[2] - ff.alpha_box(pi['left'])[0] == 300 and pp['left'] == (50, 50))
rgb, mask = ff.composite_view(views['front'], 512)
check('white background outside the object', tuple(rgb[5, 5]) == (255, 255, 255) and mask[5, 5] == 0)
check('object pixel lands at frame*512/1000 (no recentre)', tuple(rgb[int(500 * .512), int(500 * .512)]) == (200, 30, 30) and mask[int(120 * .512), int(500 * .512)] == 255 and mask[int(80 * .512), int(500 * .512)] == 0)
d = tempfile.mkdtemp(); [views[v].save(os.path.join(d, f'cut_{v}.png')) for v in views]; li, lp = ff.load_views(d); rec = ff.write_debug(os.path.join(d, 'o'), li, lp, S, None, 512, {'part': 'test'})
check('debug files written', all(os.path.exists(os.path.join(d, 'o', f)) for f in ['conditioning_front.png', 'conditioning_left_mask.png', 'framing.json', 'debug_montage_NOT_AN_INPUT.png']))
check('box height spread recorded (differs per view)', rec['box_height_spread_px'] == 80 and rec['views']['left']['box_h_px'] == 720)
check('file hash recorded', len(rec['views']['front']['file_sha256']) == 64)
try:
    import torch
    from hy3dgen.shapegen.preprocessors import MVImageProcessorV2
    p = ff.FixedFrameMVProcessor(512); out = p({'right': views['right'], 'front': views['front'], 'back': views['back'], 'left': views['left']})
    check('processor: tensors [1,4,3,512,512], mask [1,4,1,512,512], view order front,left,back,right', tuple(out['image'].shape) == (1, 4, 3, 512, 512) and tuple(out['mask'].shape) == (1, 4, 1, 512, 512) and out['view_idxs'] == (0, 1, 2, 3))
    stock = MVImageProcessorV2(size=512, border_ratio=0.15)({k: v for k, v in views.items()})
    def boxh(m): ys = np.nonzero(((m[0] + 1) / 2 * 255).numpy()[0] > 127)[0]; return int(ys.max() - ys.min() + 1)
    sh = [boxh(stock['mask'][0, i:i + 1]) for i in range(4)]; fh = [boxh(out['mask'][0, i:i + 1]) for i in range(4)]
    print('box height in the 512 conditioning image  stock:', sh, ' fixed-frame:', fh)
    check('stock rescales every view to the same 435 px; fixed-frame keeps the part proportions (800/720/760/800 of 1000)', len(set(sh)) == 1 and abs(fh[0] - 409.6) <= 1 and abs(fh[1] - 368.6) <= 1 and fh[1] < fh[0])
except ImportError as e:
    print('SKIP processor comparison (no torch/hy3dgen here):', e)
print('FAILURES', ok); sys.exit(1 if ok else 0)
