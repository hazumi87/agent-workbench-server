import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_fit as lf
src = {'neck': (610, 300), 'chin': (612, 270), 'shoulder_top': (480, 150), 'belt_top': (620, 440), 'ear_L': (532, 120), 'ear_R': (712, 118)}
def mk(s, t, jitter=None, sx_extra=1.0):
    return {k: {'source': list(v), 'part': [v[0] * s * sx_extra + t[0] + (jitter or {}).get(k, (0, 0))[0], v[1] * s + t[1] + (jitter or {}).get(k, (0, 0))[1]]} for k, v in src.items()}
fails = 0
def chk(n, c):
    global fails; print(('PASS ' if c else 'FAIL ') + n); fails += 0 if c else 1
r = lf.fit(mk(2.0, (-100, -50)), 800); chk('exact uniform map -> ACCEPT, scale 2.0, zero residual', r['verdict'] == 'ACCEPT' and abs(r['scale_part_px_per_source_px'] - 2) < 1e-9 and r['max_residual_pct_of_part_box_h'] == 0)
r = lf.fit(mk(2.0, (0, 0), {'chin': (6, -5)}), 800); chk('small jitter (7.8 px of 800 = 1%) still ACCEPT, residual reported', r['verdict'] == 'ACCEPT' and 0.5 < r['max_residual_pct_of_part_box_h'] < 1.5)
r = lf.fit(mk(2.0, (0, 0), {'chin': (40, -30)}), 800); chk('one landmark 50 px off (6%) -> REJECT', r['verdict'] == 'REJECT')
r = lf.fit(mk(2.0, (0, 0), None, sx_extra=1.12), 800); chk('12% wider than tall (proportion drift) -> REJECT with axis reason', r['verdict'] == 'REJECT' and any('x/y' in x or 'residual' in x for x in r['reasons']))
print('FAILURES', fails); sys.exit(1 if fails else 0)
