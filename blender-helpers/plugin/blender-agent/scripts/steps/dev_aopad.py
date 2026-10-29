"""dev_aopad — DEV TOOL, read-only: compare two AO u8 files of one layout against the direct mask: mask1 identical, mask0 all 255, and for mask2 texels how many equal some mask1 value in the 5x5 neighbourhood. params: a, b (u8 paths), mask, atlas_px"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def rd(k, A):
    return np.frombuffer(open(L.resolve(L.param(k)), "rb").read(), dtype=np.uint8).reshape(A, A)


def main():
    A = int(L.param("atlas_px", 1024))
    a, b, mk = rd("a", A), rd("b", A), rd("mask", A)

    def near_equal(u):
        ys, xs = np.nonzero(mk == 2)
        pu = np.pad(u.astype(np.int32), 2, constant_values=-1)
        pm = np.pad(mk, 2, constant_values=0)
        eq = np.zeros(len(ys), bool)
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                nb = pu[2 + ys + dy, 2 + xs + dx]
                eq |= (pm[2 + ys + dy, 2 + xs + dx] == 1) & (nb == u[ys, xs])
        return round(float(eq.mean()), 4)
    d = np.abs(a.astype(int) - b.astype(int))
    L.finish("aopad", save=False, mask1=int((mk == 1).sum()), mask2=int((mk == 2).sum()), a_vs_b_mask1_identical=bool((a[mk == 1] == b[mk == 1]).all()),
             a_mask0_all_255=bool((a[mk == 0] == 255).all()), b_mask0_all_255=bool((b[mk == 0] == 255).all()),
             mask2_equal_to_a_mask1_value_in_5x5={"a": near_equal(a), "b": near_equal(b)}, mask2_abs_diff_a_vs_b={"max": int(d[mk == 2].max()), "mean": round(float(d[mk == 2].mean()), 2)})


L.run(main)
