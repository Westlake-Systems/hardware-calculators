#!/usr/bin/env python3
"""Field-solver reference set for the impedance calculator: random practical PCB geometries, solved by
scripts/impedance-fieldsolve.py, written to scripts/impedance-reference.json for scripts/test-impedance.ts.

Usage: python3 scripts/impedance-sweep.py [workers]   (about 15 minutes on 14 workers)
The seed is fixed, so the set is reproducible. Lengths in mm.
"""
import json
import os
import random
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(__file__))
from importlib import import_module

fs = import_module('impedance-fieldsolve')

COPPER = [0.0175, 0.035, 0.07]  # 1/2, 1 and 2 oz
ER = [3.0, 3.5, 3.7, 4.0, 4.2, 4.5, 4.8, 2.2, 3.38, 6.15, 10.2]


def logu(r, lo, hi):
    return lo * (hi / lo) ** r.random()


def grid(dims, big):
    small = min(d for d in dims if d > 0)
    return small / 50, big / 6


MIN_FEATURE = 0.075  # 3 mil: about the finest trace and gap most board houses make


def practical(p):
    """Rejects geometries no board would use: features under 3 mil, copper over half the dielectric."""
    feats = [p[k] for k in ('w', 's', 'g') if k in p]
    diel = [p[k] for k in ('h', 'h1', 'h2') if k in p]
    return min(feats) >= MIN_FEATURE and p['t'] <= 0.5 * min(diel)


def make(kind, r):
    while True:
        p, g, fine = make_any(kind, r)
        if practical(p):
            return p, g, fine


def make_any(kind, r):
    t = r.choice(COPPER)
    er = r.choice(ER)
    if kind == 'microstrip':
        h = logu(r, 0.05, 1.6)
        w = h * logu(r, 0.2, 8)
        g = fs.microstrip(w, h, t, er)
        p = dict(w=w, h=h, t=t, er=er)
        return p, g, grid([w, h, t], max(w, h))
    if kind == 'stripline':
        h1 = logu(r, 0.05, 0.6)
        h2 = h1 * logu(r, 1, 5) if r.random() < 0.7 else h1
        w = (h1 + h2) * logu(r, 0.1, 3)
        g = fs.stripline(w, h1, h2, t, er)
        return dict(w=w, h1=h1, h2=h2, t=t, er=er), g, grid([w, h1, h2, t], max(w, h1 + h2))
    if kind == 'cpwg':
        h = logu(r, 0.1, 1.6)
        w = h * logu(r, 0.3, 5)
        gap = h * logu(r, 0.05, 3)
        g = fs.cpwg(w, gap, h, t, er)
        return dict(w=w, g=gap, h=h, t=t, er=er), g, grid([w, gap, h, t], max(w, h))
    if kind == 'diffMicrostrip':
        h = logu(r, 0.05, 1.0)
        w = h * logu(r, 0.2, 4)
        s = h * logu(r, 0.2, 5)
        g = fs.microstrip(w, h, t, er, s)
        return dict(w=w, s=s, h=h, t=t, er=er), g, grid([w, s, h, t], max(w, h))
    if kind == 'diffStripline':
        h1 = logu(r, 0.05, 0.4)
        h2 = h1 * logu(r, 1, 4) if r.random() < 0.6 else h1
        b = h1 + h2 + t
        w = b * logu(r, 0.1, 1.5)
        s = b * logu(r, 0.1, 3)
        g = fs.stripline(w, h1, h2, t, er, s)
        return dict(w=w, s=s, h1=h1, h2=h2, t=t, er=er), g, grid([w, s, h1, h2, t], max(w, b))
    raise ValueError(kind)


# Fixed extra cases: grounded coplanar with narrow gaps on thick boards (two-layer RF boards).
EXTRA_CPWG = [(0.84, 0.15, 1.6, 0.035, 4.3), (1.1, 0.2, 1.6, 0.035, 4.3), (0.6, 0.1, 1.6, 0.035, 4.3),
              (1.5, 0.3, 1.6, 0.035, 4.3), (0.5, 0.1, 1.0, 0.035, 4.3), (0.4, 0.1, 1.6, 0.07, 3.5),
              (1.0, 0.12, 1.5, 0.0175, 4.5)]


def extra(n):
    w, gap, h, t, er = EXTRA_CPWG[n]
    return dict(w=w, g=gap, h=h, t=t, er=er), fs.cpwg(w, gap, h, t, er), grid([w, gap, h, t], max(w, h))


def work(job):
    kind, seed = job
    r = random.Random(seed)
    p, g, (hmin, hmax) = extra(seed - 9000) if seed >= 9000 else make(kind, r)
    pair = kind.startswith('diff')
    out = dict(kind=kind, seed=seed, **{k: round(v, 6) for k, v in p.items()})
    if pair:
        f = fs.pair(g, hmin, hmax, fs.FINE)
        c = fs.pair(g, 2 * hmin, 2 * hmax)
        for m in ('even', 'odd'):
            out[f'z_{m}'] = round(2 * f[m][0] - c[m][0], 4)
            out[f'e_{m}'] = round(2 * f[m][1] - c[m][1], 5)
            out[f'grid_change_{m}'] = round((f[m][0] - c[m][0]) / f[m][0], 5)
    else:
        zf, ef = fs.single(g, hmin, hmax, fs.FINE)
        zc, ec = fs.single(g, 2 * hmin, 2 * hmax)
        out['z'] = round(2 * zf - zc, 4)
        out['e'] = round(2 * ef - ec, 5)
        out['grid_change'] = round((zf - zc) / zf, 5)
    return out


if __name__ == '__main__':
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    counts = dict(microstrip=40, stripline=60, cpwg=60, diffMicrostrip=60, diffStripline=60)
    jobs = [(k, 1000 * i + n) for i, (k, c) in enumerate(counts.items()) for n in range(c)]
    jobs += [('cpwg', 9000 + n) for n in range(len(EXTRA_CPWG))]
    with Pool(workers) as pool:
        results = []
        for n, res in enumerate(pool.imap_unordered(work, jobs), 1):
            results.append(res)
            if n % 20 == 0:
                print(f'{n}/{len(jobs)}', flush=True)
    results.sort(key=lambda x: (x['kind'], x['seed']))
    path = os.path.join(os.path.dirname(__file__), 'impedance-reference.json')
    with open(path, 'w') as f:
        f.write('[\n' + ',\n'.join(json.dumps(x) for x in results) + '\n]\n')
    print(f'wrote {len(results)} cases to {path}')
