#!/usr/bin/env python3
"""Field-solver reference set for the solder-mask estimate: outer-layer lines (microstrip, grounded
coplanar, differential microstrip) solved bare and with a conformal mask coating (on the board
surface and over the copper, lining the gaps), written to scripts/impedance-mask-reference.json.
The calculator applies the field solver's ratio, masked / bare, through a fitted estimate.

Usage: python3 scripts/impedance-mask-sweep.py [workers]   (about 10 minutes on 14 workers)
"""
import json
import os
import random
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(__file__))
from importlib import import_module

fs = import_module('impedance-fieldsolve')
sw = import_module('impedance-sweep')


def coat(kind, p, g, c, er_m):
    """The geometry with a conformal mask c thick: on the substrate surface and over each conductor."""
    h, t = p['h'], p['t']
    layers = [*g.layers, (h, h + c, er_m)]
    kx, ky = [], [h + c, h + t + c]
    for x0, x1, y0, y1, name in g.conductors:
        layers.append((max(x0 - c, -g.width), min(x1 + c, g.width), h, h + t + c, er_m))
        kx += [x0 - c, x1 + c]
    kx = [x for x in kx if -g.width < x < g.width]
    return fs.Geometry(g.conductors, layers, g.width, g.top, g.top_is_ground, [*g.key_x, *kx], [*g.key_y, *ky])


def solve(kind, g, hmin, hmax):
    """Richardson-extrapolated (Z, eeff) for single lines; (Zodd, Zeven, eodd) for pairs."""
    if kind == 'diffMicrostrip':
        f = fs.pair(g, hmin, hmax, fs.FINE)
        c = fs.pair(g, 2 * hmin, 2 * hmax)
        return [2 * f[m][i] - c[m][i] for m, i in (('odd', 0), ('even', 0), ('odd', 1))]
    zf, ef = fs.single(g, hmin, hmax, fs.FINE)
    zc, ec = fs.single(g, 2 * hmin, 2 * hmax)
    return [2 * zf - zc, 2 * ef - ec]


def work(job):
    kind, seed = job
    r = random.Random(seed)
    p, g, (hmin, hmax) = sw.make(kind, r)
    c = round(r.uniform(0.008, 0.035), 4)  # mask thickness over the copper, mm
    er_m = round(r.uniform(3.2, 4.0), 2)
    hmin = min(hmin, c / 4)
    bare = solve(kind, g, hmin, hmax)
    masked = solve(kind, coat(kind, p, g, c, er_m), hmin, hmax)
    return dict(kind=kind, seed=seed, **{k: round(v, 6) for k, v in p.items()}, mask=c, er_mask=er_m,
                bare=[round(x, 5) for x in bare], masked=[round(x, 5) for x in masked])


if __name__ == '__main__':
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    counts = dict(microstrip=40, cpwg=30, diffMicrostrip=40)
    jobs = [(k, 20000 + 1000 * i + n) for i, (k, n_) in enumerate(counts.items()) for n in range(n_)]
    with Pool(workers) as pool:
        results = []
        for n, res in enumerate(pool.imap_unordered(work, jobs), 1):
            results.append(res)
            if n % 10 == 0:
                print(f'{n}/{len(jobs)}', flush=True)
    results.sort(key=lambda x: (x['kind'], x['seed']))
    path = os.path.join(os.path.dirname(__file__), 'impedance-mask-reference.json')
    with open(path, 'w') as f:
        f.write('[\n' + ',\n'.join(json.dumps(x) for x in results) + '\n]\n')
    print(f'wrote {len(results)} cases to {path}')
