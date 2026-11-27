#!/usr/bin/env python3
"""Independent 2D electrostatic field solver for checking src/lib/impedance.ts.

Solves Laplace's equation div(eps grad phi) = 0 by finite volumes on a graded rectangular grid, once with
the dielectrics and once in air, and takes the line capacitance from the stored field energy. Then
Z0 = 1 / (c sqrt(C C_air)) and eps_eff = C / C_air (quasi-TEM). Coupled pairs: even mode (both lines at
+1 V) and odd mode (+1 V and -1 V).

It shares no code or formula with the closed forms in the calculator, so agreement between the two is
a real check. Each case is solved on two grids, every cell halved between them, and extrapolated
(Richardson). `python3 scripts/impedance-fieldsolve.py [name filter]` prints the spot cases below
(about a minute, single-threaded); scripts/impedance-sweep.py builds the reference set the test
(scripts/test-impedance.ts) reads. Needs numpy and scipy.

Geometry is in millimetres; every structure sits on a ground plane at y = 0.
"""
import sys
from dataclasses import dataclass, field

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

C0 = 299_792_458.0
EPS0 = 8.8541878128e-12


RATIO = 1.12  # grid growth away from each key point (coarse grid)
FINE = RATIO ** 0.5  # the fine grid: half the steps everywhere, including the graded regions


def graded(points, hmin, hmax, ratio=RATIO):
    """Grid lines through every key point, fine (hmin) next to each point, growing by `ratio` up to hmax."""
    pts = sorted(set(round(p, 9) for p in points))
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        # Steps from both ends, growing geometrically, meeting in the middle.
        left, right = [], []
        h = hmin
        span = b - a
        acc = 0.0
        while True:
            # Stop while at least one more step is left over for the middle (no sliver cells).
            if acc + 3 * h > span:
                break
            left.append(h)
            right.append(h)
            acc += 2 * h
            h = min(h * ratio, hmax)
        # Fill what is left with equal steps no larger than hmax.
        rest = span - acc
        n = max(1, int(np.ceil(rest / hmax)))
        middle = [rest / n] * n
        steps = left + middle + right[::-1]
        x = a
        for s in steps[:-1]:
            x += s
            out.append(x)
        out.append(b)
    return np.array(out)


@dataclass
class Geometry:
    # Conductors: (x0, x1, y0, y1, name); name 'gnd', 'a' or 'b'. Zero height (y0 == y1) is a thin strip.
    conductors: list
    # Dielectric layers: (y0, y1, eps_r); anything not covered is air.
    layers: list
    width: float  # half-width of the box (centred on x = 0)
    top: float  # box top (a ground for stripline, far away for microstrip)
    top_is_ground: bool = True
    key_x: list = field(default_factory=list)
    key_y: list = field(default_factory=list)


def solve(g: Geometry, volts: dict, use_dielectric: bool, hmin: float, hmax: float, ratio=RATIO):
    xs = graded([-g.width, g.width, *g.key_x], hmin, hmax, ratio)
    ys = graded([0.0, g.top, *g.key_y], hmin, hmax, ratio)
    nx, ny = len(xs), len(ys)
    dx = np.diff(xs)
    dy = np.diff(ys)
    # Cell permittivity (cells are between grid lines).
    eps = np.ones((nx - 1, ny - 1))
    if use_dielectric:
        yc = (ys[:-1] + ys[1:]) / 2
        xc = (xs[:-1] + xs[1:]) / 2
        for layer in g.layers:
            if len(layer) == 3:  # a full-width layer
                y0, y1, er = layer
                eps[:, (yc > y0) & (yc < y1)] = er
            else:  # a rectangle: (x0, x1, y0, y1, er)
                x0, x1, y0, y1, er = layer
                eps[np.outer((xc > x0) & (xc < x1), (yc > y0) & (yc < y1))] = er
    # Fixed nodes: boundary (0 V) and conductors.
    fixed = np.zeros((nx, ny), bool)
    value = np.zeros((nx, ny))
    fixed[0, :] = fixed[-1, :] = True
    fixed[:, 0] = True
    # The top is a ground plane (stripline) or a far wall at 0 V (open structures; the box is many
    # dielectric thicknesses tall and wide, so the wall changes the result by under 0.1%).
    fixed[:, -1] = True
    tol = 1e-9
    for x0, x1, y0, y1, name in g.conductors:
        ix = (xs >= x0 - tol) & (xs <= x1 + tol)
        iy = (ys >= y0 - tol) & (ys <= y1 + tol)
        m = np.outer(ix, iy)
        fixed |= m
        value[m] = volts.get(name, 0.0)

    # Edge coefficients. x-edge (i,j)-(i+1,j): face height is half of each neighbouring cell row.
    cx = np.zeros((nx - 1, ny))
    cx[:, :-1] += eps * dy[None, :] / 2
    cx[:, 1:] += eps * dy[None, :] / 2
    cx /= dx[:, None]
    cy = np.zeros((nx, ny - 1))
    cy[:-1, :] += eps * dx[:, None] / 2
    cy[1:, :] += eps * dx[:, None] / 2
    cy /= dy[None, :]

    idx = -np.ones((nx, ny), int)
    free = ~fixed
    idx[free] = np.arange(free.sum())
    n = int(free.sum())
    rows, cols, vals = [], [], []
    rhs = np.zeros(n)
    diag = np.zeros(n)

    def couple(ia, ib, c):
        # Edges between nodes a and b with coefficient c (arrays of flat node indices).
        a_free = free.ravel()[ia]
        b_free = free.ravel()[ib]
        fa = idx.ravel()[ia]
        fb = idx.ravel()[ib]
        np.add.at(diag, fa[a_free], c[a_free])
        np.add.at(diag, fb[b_free], c[b_free])
        both = a_free & b_free
        rows.extend([fa[both], fb[both]])
        cols.extend([fb[both], fa[both]])
        vals.extend([-c[both], -c[both]])
        va = value.ravel()[ia]
        vb = value.ravel()[ib]
        sel = a_free & ~b_free
        np.add.at(rhs, fa[sel], c[sel] * vb[sel])
        sel = b_free & ~a_free
        np.add.at(rhs, fb[sel], c[sel] * va[sel])

    flat = np.arange(nx * ny).reshape(nx, ny)
    couple(flat[:-1, :].ravel(), flat[1:, :].ravel(), cx.ravel())
    couple(flat[:, :-1].ravel(), flat[:, 1:].ravel(), cy.ravel())
    rows.append(np.arange(n))
    cols.append(np.arange(n))
    vals.append(diag)
    A = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n))
    phi = value.copy()
    phi[free] = spla.spsolve(A.tocsc(), rhs)
    # Energy per unit length (times 2 / eps0): sum of c (dphi)^2.
    w = (cx * np.diff(phi, axis=0) ** 2).sum() + (cy * np.diff(phi, axis=1) ** 2).sum()
    return w * EPS0  # = 2 * energy per metre... scaled below


def capacitance(g, volts, diel, hmin, hmax, ratio=RATIO):
    # Energy W = 1/2 * eps0 * sum c dphi^2 (units: lengths cancel in 2D). Return sum V_i Q_i = 2W.
    return solve(g, volts, diel, hmin, hmax, ratio)


def single(g, hmin, hmax, ratio=RATIO):
    c = capacitance(g, {'a': 1.0}, True, hmin, hmax, ratio)
    c_air = capacitance(g, {'a': 1.0}, False, hmin, hmax, ratio)
    return 1 / (C0 * np.sqrt(c * c_air)), c / c_air


def pair(g, hmin, hmax, ratio=RATIO):
    """Even and odd mode impedances. With V = +-1, sum V Q = 2 C_mode per line pair, so C_mode = 2W/2."""
    out = {}
    for mode, v in (('even', {'a': 1.0, 'b': 1.0}), ('odd', {'a': 1.0, 'b': -1.0})):
        c = capacitance(g, v, True, hmin, hmax, ratio) / 2
        c_air = capacitance(g, v, False, hmin, hmax, ratio) / 2
        out[mode] = (1 / (C0 * np.sqrt(c * c_air)), c / c_air)
    return out


# Geometry builders. w, s, g, t, h in mm.
def microstrip(w, h, t, er, s=None):
    box = max(25 * h, 12 * (w + (s or 0)))
    conds = []
    if s is None:
        conds.append((-w / 2, w / 2, h, h + t, 'a'))
        kx = [-w / 2, w / 2]
    else:
        conds.append((-s / 2 - w, -s / 2, h, h + t, 'a'))
        conds.append((s / 2, s / 2 + w, h, h + t, 'b'))
        kx = [-s / 2 - w, -s / 2, s / 2, s / 2 + w]
    return Geometry(conds, [(0, h, er)], box, box, False, kx, [h, h + t])


def stripline(w, h1, h2, t, er, s=None):
    """Signal between planes: h1 below it, h2 above its top surface. Total b = h1 + t + h2."""
    b = h1 + t + h2
    box = max(15 * b, 8 * (w + (s or 0)))
    if s is None:
        conds = [(-w / 2, w / 2, h1, h1 + t, 'a')]
        kx = [-w / 2, w / 2]
    else:
        conds = [(-s / 2 - w, -s / 2, h1, h1 + t, 'a'), (s / 2, s / 2 + w, h1, h1 + t, 'b')]
        kx = [-s / 2 - w, -s / 2, s / 2, s / 2 + w]
    return Geometry(conds, [(0, b, er)], box, b, True, kx, [h1, h1 + t])


def cpwg(w, gap, h, t, er):
    """Grounded coplanar: side grounds from the gap out to the box edge, on the same layer."""
    box = max(25 * h, 12 * (w + 2 * gap))
    conds = [
        (-w / 2, w / 2, h, h + t, 'a'),
        (-box, -w / 2 - gap, h, h + t, 'gnd'),
        (w / 2 + gap, box, h, h + t, 'gnd'),
    ]
    kx = [-w / 2, w / 2, -w / 2 - gap, w / 2 + gap]
    return Geometry(conds, [(0, h, er)], box, box, False, kx, [h, h + t])


def masked(g: Geometry, h, t, mask, er_mask):
    """The same structure with a solder mask layer from the board surface to `mask` above the copper
    (filling the gaps, which real mask does only partly: an upper bound on its effect)."""
    layers = [(h, h + t + mask, er_mask), *g.layers]
    return Geometry(g.conductors, layers, g.width, g.top, g.top_is_ground, g.key_x, [*g.key_y, h + t + mask])


def coated(g: Geometry, h, t, mask, er_mask, traces):
    """Solder mask as a coating: `mask` thick on the board surface and over each trace (top and sides)."""
    layers = [*g.layers, (h, h + mask, er_mask)]
    keys = [h + mask, h + t + mask]
    kx = []
    for x0, x1 in traces:
        layers.append((x0 - mask, x1 + mask, h, h + t + mask, er_mask))
        kx += [x0 - mask, x1 + mask]
    return Geometry(g.conductors, layers, g.width, g.top, g.top_is_ground, [*g.key_x, *kx], [*g.key_y, *keys])


def run(label, kind, g, fine):
    """Solves on two grids, every cell halved from coarse to fine, and extrapolates: the error falls
    about linearly with the grid step near the strip edges, so 2 * fine - coarse removes most of it
    (checked against the exact zero-thickness cases)."""
    hmin, hmax = fine
    if kind == 'single':
        zf, ef = single(g, hmin, hmax, FINE)
        zc, ec = single(g, 2 * hmin, 2 * hmax)
        z, e = 2 * zf - zc, 2 * ef - ec
        print(f"{label}: Z0 {z:.3f} ohm, eps_eff {e:.4f} (grid h {zf:.3f}, 2h {zc:.3f})", flush=True)
        return z, e
    mf = pair(g, hmin, hmax, FINE)
    mc = pair(g, 2 * hmin, 2 * hmax)
    ze, zo = (2 * mf[m][0] - mc[m][0] for m in ('even', 'odd'))
    ee, eo = (2 * mf[m][1] - mc[m][1] for m in ('even', 'odd'))
    print(f"{label}: Zodd {zo:.3f}, Zeven {ze:.3f}, Zdiff {2 * zo:.3f} ohm, eps_eff odd {eo:.4f} even {ee:.4f} (grid h odd {mf['odd'][0]:.3f}, 2h {mc['odd'][0]:.3f})", flush=True)
    return ze, zo


if __name__ == '__main__':
    # Accuracy of the solver itself, against exact results (zero-thickness stripline, Cohn).
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    T = 0.035
    cases = {
        # name: (kind, geometry, (hmin, hmax))
        'stripline t=0 w=0.2 b=0.5 er=4': ('single', stripline(0.2, 0.25, 0.25, 0.0, 4.0), (0.0015, 0.03)),
        'stripline t=0 w=0.2 b=0.5 er=4 (coarser)': ('single', stripline(0.2, 0.25, 0.25, 0.0, 4.0), (0.003, 0.06)),
        'coupled stripline t=0 w=0.15 s=0.15 b=0.5 er=4': ('pair', stripline(0.15, 0.25, 0.25, 0.0, 4.0, 0.15), (0.0015, 0.03)),
        # Microstrip, zero thickness and 1 oz.
        'microstrip t=0 w=3.0 h=1.6 er=4.5': ('single', microstrip(3.0, 1.6, 0.0, 4.5), (0.006, 0.3)),
        'microstrip t=0 w=0.3 h=0.2 er=4.2': ('single', microstrip(0.3, 0.2, 0.0, 4.2), (0.001, 0.04)),
        'microstrip t=35um w=0.3 h=0.2 er=4.2': ('single', microstrip(0.3, 0.2, T, 4.2), (0.001, 0.04)),
        'microstrip t=35um w=0.1 h=0.2 er=4.2': ('single', microstrip(0.1, 0.2, T, 4.2), (0.001, 0.04)),
        'microstrip t=35um w=1.0 h=0.2 er=4.2': ('single', microstrip(1.0, 0.2, T, 4.2), (0.001, 0.04)),
        'microstrip t=35um w=0.36 h=0.2 er=3.5': ('single', microstrip(0.36, 0.2, T, 3.5), (0.001, 0.04)),
        # Stripline, 1 oz, symmetric and offset.
        'stripline t=35um w=0.15 h1=h2=0.2 er=4.2': ('single', stripline(0.15, 0.2, 0.2, T, 4.2), (0.001, 0.03)),
        'stripline t=17.5um w=0.1 h1=h2=0.15 er=3.7': ('single', stripline(0.1, 0.15, 0.15, 0.0175, 3.7), (0.001, 0.03)),
        'stripline t=35um w=0.15 h1=0.15 h2=0.35 er=4.2': ('single', stripline(0.15, 0.15, 0.35, T, 4.2), (0.001, 0.03)),
        'stripline t=35um w=0.4 h1=h2=0.2 er=4.2': ('single', stripline(0.4, 0.2, 0.2, T, 4.2), (0.001, 0.03)),
        # Grounded coplanar.
        'cpwg t=0 w=0.3 g=0.15 h=0.2 er=4.2': ('single', cpwg(0.3, 0.15, 0.2, 0.0, 4.2), (0.001, 0.04)),
        'cpwg t=35um w=0.3 g=0.15 h=0.2 er=4.2': ('single', cpwg(0.3, 0.15, 0.2, T, 4.2), (0.001, 0.04)),
        'cpwg t=35um w=1.0 g=0.2 h=1.5 er=4.5': ('single', cpwg(1.0, 0.2, 1.5, T, 4.5), (0.003, 0.15)),
        'cpwg t=35um w=0.5 g=0.5 h=0.2 er=4.2': ('single', cpwg(0.5, 0.5, 0.2, T, 4.2), (0.001, 0.04)),
        # Edge-coupled microstrip and stripline, 1 oz.
        'coupled microstrip t=35um w=0.15 s=0.15 h=0.1 er=4.2': ('pair', microstrip(0.15, 0.1, T, 4.2, 0.15), (0.0008, 0.03)),
        'coupled microstrip t=35um w=0.2 s=0.2 h=0.2 er=4.2': ('pair', microstrip(0.2, 0.2, T, 4.2, 0.2), (0.001, 0.04)),
        'coupled microstrip t=35um w=0.15 s=0.5 h=0.2 er=4.2': ('pair', microstrip(0.15, 0.2, T, 4.2, 0.5), (0.001, 0.04)),
        'coupled microstrip t=0 w=0.2 s=0.2 h=0.2 er=4.2': ('pair', microstrip(0.2, 0.2, 0.0, 4.2, 0.2), (0.001, 0.04)),
        'coupled stripline t=35um w=0.1 s=0.15 h1=h2=0.15 er=4.2': ('pair', stripline(0.1, 0.15, 0.15, T, 4.2, 0.15), (0.0008, 0.03)),
        'coupled stripline t=35um w=0.15 s=0.3 h1=h2=0.2 er=4.2': ('pair', stripline(0.15, 0.2, 0.2, T, 4.2, 0.3), (0.001, 0.03)),
        # More cases for the thickness and offset corrections.
        'stripline t=35um w=0.15 h1=0.1 h2=0.4 er=4.2': ('single', stripline(0.15, 0.1, 0.4, T, 4.2), (0.001, 0.03)),
        'stripline t=35um w=0.2 h1=0.2 h2=0.6 er=4.2': ('single', stripline(0.2, 0.2, 0.6, T, 4.2), (0.001, 0.03)),
        'cpwg t=35um w=0.3 g=0.2 h=0.2 er=4.2': ('single', cpwg(0.3, 0.2, 0.2, T, 4.2), (0.001, 0.04)),
        'cpwg t=35um w=0.2 g=0.1 h=0.1 er=4.2': ('single', cpwg(0.2, 0.1, 0.1, T, 4.2), (0.0008, 0.03)),
        'cpwg t=70um w=0.6 g=0.15 h=0.4 er=4.2': ('single', cpwg(0.6, 0.15, 0.4, 0.07, 4.2), (0.001, 0.05)),
        'cpwg t=17.5um w=0.3 g=0.15 h=0.2 er=4.2': ('single', cpwg(0.3, 0.15, 0.2, 0.0175, 4.2), (0.001, 0.04)),
        'cpwg t=35um w=0.3 g=0.3 h=1.0 er=4.2': ('single', cpwg(0.3, 0.3, 1.0, T, 4.2), (0.002, 0.1)),
        'coupled microstrip t=35um w=0.1 s=0.1 h=0.1 er=4.2': ('pair', microstrip(0.1, 0.1, T, 4.2, 0.1), (0.0008, 0.03)),
        'coupled microstrip t=35um w=0.3 s=0.15 h=0.2 er=4.2': ('pair', microstrip(0.3, 0.2, T, 4.2, 0.15), (0.001, 0.04)),
        'coupled microstrip t=70um w=0.2 s=0.2 h=0.2 er=4.2': ('pair', microstrip(0.2, 0.2, 0.07, 4.2, 0.2), (0.001, 0.04)),
        'coupled microstrip t=35um w=0.12 s=0.2 h=0.09 er=3.7': ('pair', microstrip(0.12, 0.09, T, 3.7, 0.2), (0.0008, 0.03)),
        'coupled microstrip t=35um w=0.5 s=1.0 h=1.0 er=4.5': ('pair', microstrip(0.5, 1.0, T, 4.5, 1.0), (0.002, 0.1)),
        'coupled stripline t=35um w=0.1 s=0.1 h1=h2=0.2 er=4.2': ('pair', stripline(0.1, 0.2, 0.2, T, 4.2, 0.1), (0.0008, 0.03)),
        'coupled stripline t=35um w=0.2 s=0.2 h1=h2=0.3 er=4.2': ('pair', stripline(0.2, 0.3, 0.3, T, 4.2, 0.2), (0.001, 0.03)),
        'coupled stripline t=17.5um w=0.1 s=0.2 h1=h2=0.1 er=3.7': ('pair', stripline(0.1, 0.1, 0.1, 0.0175, 3.7, 0.2), (0.0008, 0.03)),
        'coupled stripline t=35um w=0.1 s=0.15 h1=0.1 h2=0.25 er=4.2': ('pair', stripline(0.1, 0.1, 0.25, T, 4.2, 0.15), (0.0008, 0.03)),
        'coupled stripline t=35um w=0.12 s=0.12 h1=0.12 h2=0.4 er=4.2': ('pair', stripline(0.12, 0.12, 0.4, T, 4.2, 0.12), (0.0008, 0.03)),
        # Solder mask over a microstrip (20 um above the copper, er 3.5).
        'mask microstrip t=35um w=0.36 h=0.2 er=4.2': ('single', masked(microstrip(0.36, 0.2, T, 4.2), 0.2, T, 0.02, 3.5), (0.001, 0.04)),
        'mask coupled microstrip t=35um w=0.15 s=0.2 h=0.1 er=4.2': ('pair', masked(microstrip(0.15, 0.1, T, 4.2, 0.2), 0.1, T, 0.02, 3.5), (0.0008, 0.03)),
        'coat microstrip t=35um w=0.36 h=0.2 er=4.2 mask 20um': ('single', coated(microstrip(0.36, 0.2, T, 4.2), 0.2, T, 0.02, 3.5, [(-0.18, 0.18)]), (0.001, 0.04)),
        'coat microstrip t=35um w=0.36 h=0.2 er=4.2 mask 10um': ('single', coated(microstrip(0.36, 0.2, T, 4.2), 0.2, T, 0.01, 3.5, [(-0.18, 0.18)]), (0.001, 0.04)),
        'coat coupled microstrip t=35um w=0.15 s=0.2 h=0.1 er=4.2 mask 20um': ('pair', coated(microstrip(0.15, 0.1, T, 4.2, 0.2), 0.1, T, 0.02, 3.5, [(-0.25, -0.1), (0.1, 0.25)]), (0.0008, 0.03)),
        'coat coupled microstrip t=35um w=0.15 s=0.2 h=0.1 er=4.2 mask 10um': ('pair', coated(microstrip(0.15, 0.1, T, 4.2, 0.2), 0.1, T, 0.01, 3.5, [(-0.25, -0.1), (0.1, 0.25)]), (0.0008, 0.03)),
        'nomask coupled microstrip t=35um w=0.15 s=0.2 h=0.1 er=4.2': ('pair', microstrip(0.15, 0.1, T, 4.2, 0.2), (0.0008, 0.03)),
    }
    for name, (kind, g, fine) in cases.items():
        if which == 'all' or which in name:
            run(name, kind, g, fine)
