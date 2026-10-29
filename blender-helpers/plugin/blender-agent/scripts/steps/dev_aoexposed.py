"""dev_aoexposed — DEV TOOL, read-only: AO value (u8 file) at covered texels split by the direct value (f16 bin, first channel): exposed (direct > thr) vs direct zero. params: bin, ao, mask, atlas_px, channel, thr"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def main():
    A = int(L.param("atlas_px", 1024))
    ch = int(L.param("channel", 0))
    thr = float(L.param("thr", 0.003))
    b = np.frombuffer(open(L.resolve(L.param("bin")), "rb").read(), dtype="<f2").reshape(A, A, 4)[:, :, ch].astype(np.float64)
    ao = np.frombuffer(open(L.resolve(L.param("ao")), "rb").read(), dtype=np.uint8).reshape(A, A)
    mk = np.frombuffer(open(L.resolve(L.param("mask")), "rb").read(), dtype=np.uint8).reshape(A, A)
    cov = mk == 1

    def st(sel):
        a = ao[sel]
        if not len(a):
            return {"n": 0}
        return {"n": int(len(a)), "ao_min": int(a.min()), "p10": int(np.percentile(a, 10)), "median": int(np.median(a)), "p90": int(np.percentile(a, 90)), "max": int(a.max()), "share_below_64": round(float((a < 64).mean()), 3)}
    L.finish("aoexposed", save=False, covered=int(cov.sum()), exposed_direct=st(cov & (b > thr)), direct_zero=st(cov & (b <= 0)), direct_small=st(cov & (b > 0) & (b <= thr)))


L.run(main)
