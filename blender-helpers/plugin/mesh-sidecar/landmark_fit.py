"""landmark_fit.py -- fit a redrawn part image back to the common source with ONE uniform scale (no rotation, no shear) and gate on the residuals.

Input JSON: {"landmarks": {"chin": {"source": [x, y], "part": [x, y]}, "neck_centre_yc": {...}, ...},
             "part_box_h_px": <alpha box height of the part image>, "max_residual_pct": 2.0, "max_axis_ratio_dev_pct": 3.0}
Model: part = s * source + t  (s scalar, t 2-vector), least squares. Also fits x and y separately: sx, sy (their ratio is the anisotropy = proportion drift).
Output: s, t, per-landmark residual in source px and as % of the part's box height, sx/sy, verdict (ACCEPT / REJECT with reasons), source px per part px = 1/s.
Usage: python landmark_fit.py landmarks.json [--out fit.json]     (numpy only; the redraw is generative, so residuals are the evidence, not an assumption)"""
import json, sys
import numpy as np


def fit(lm, part_box_h_px, max_residual_pct=2.0, max_axis_ratio_dev_pct=3.0):
    names = sorted(lm); S = np.array([lm[n]['source'] for n in names], float); P = np.array([lm[n]['part'] for n in names], float)
    if len(names) < 3: raise ValueError('need at least 3 landmarks (4+ recommended: neck centre, chin, shoulder-top, belt-top)')
    Sc, Pc = S - S.mean(0), P - P.mean(0); s = float((Sc * Pc).sum() / (Sc * Sc).sum()); t = P.mean(0) - s * S.mean(0)
    pred = s * S + t; res_part = np.linalg.norm(pred - P, axis=1); res_src = res_part / s
    sx = float((Sc[:, 0] * Pc[:, 0]).sum() / (Sc[:, 0] ** 2).sum()) if (Sc[:, 0] ** 2).sum() > 0 else None; sy = float((Sc[:, 1] * Pc[:, 1]).sum() / (Sc[:, 1] ** 2).sum()) if (Sc[:, 1] ** 2).sum() > 0 else None
    out = {'scale_part_px_per_source_px': s, 'source_px_per_part_px': 1 / s, 'translation_part_px': t.tolist(), 'landmarks': {n: {'residual_part_px': round(float(r), 2), 'residual_source_px': round(float(rs), 2), 'residual_pct_of_part_box_h': round(float(r) / part_box_h_px * 100, 2)} for n, r, rs in zip(names, res_part, res_src)},
           'max_residual_pct_of_part_box_h': round(float(res_part.max()) / part_box_h_px * 100, 2), 'rms_residual_pct_of_part_box_h': round(float(np.sqrt((res_part ** 2).mean())) / part_box_h_px * 100, 2), 'sx': sx, 'sy': sy}
    reasons = []
    if out['max_residual_pct_of_part_box_h'] > max_residual_pct: reasons.append(f"max residual {out['max_residual_pct_of_part_box_h']}% > {max_residual_pct}% of the part height")
    if sx and sy:
        dev = abs(sx / sy - 1) * 100; out['axis_ratio_sx_over_sy'] = round(sx / sy, 4); out['axis_ratio_dev_pct'] = round(dev, 2)
        if dev > max_axis_ratio_dev_pct: reasons.append(f'x/y scales differ by {dev:.1f}% > {max_axis_ratio_dev_pct}% (proportion drift)')
    out['verdict'] = 'REJECT' if reasons else 'ACCEPT'; out['reasons'] = reasons; return out


if __name__ == '__main__':
    cfg = json.load(open(sys.argv[1])); r = fit(cfg['landmarks'], cfg['part_box_h_px'], cfg.get('max_residual_pct', 2.0), cfg.get('max_axis_ratio_dev_pct', 3.0))
    if '--out' in sys.argv: json.dump(r, open(sys.argv[sys.argv.index('--out') + 1], 'w'), indent=1)
    print(json.dumps({k: r[k] for k in ('scale_part_px_per_source_px', 'source_px_per_part_px', 'max_residual_pct_of_part_box_h', 'rms_residual_pct_of_part_box_h', 'axis_ratio_sx_over_sy', 'verdict', 'reasons') if k in r}, indent=1))
