"""
Route agent: the same camera-only tracker as tracking_agent.py, but the MAP is rebuilt so the route is real.

What was wrong before
---------------------
The maze reuses the same wall posters in many places. A single frame pair that "matches" is therefore often two
DIFFERENT places showing the same poster. Those false shortcuts made the goal look ~30 steps away from almost
anywhere, so the hints led you towards a place that does not connect to the goal.

What this file changes
----------------------
A visual link between two frames is only kept if it is part of an OVERLAP: when two drives really pass through the
same corridor, the frames next to the linked pair match each other as well, in a long run
(i-6..i+6 against j-6..j+6, in the same or the opposite direction). One matching poster gives a lone pair; a real
overlap gives a whole diagonal of matches. Only the diagonals become links (every verified pair in the run is
added, so the route can cross at any point of the overlap, not just at one frame).

Everything else (localisation, depth cue, press calibration, H key, hint wording) is inherited from
tracking_agent.py unchanged. Run it exactly like the tracking agent:

    uv run python source/route_agent.py ...

The first start builds and caches the verified links (about 2-4 minutes). Later starts load them from cache/.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import cli
import cv2
import networkx as nx
import numpy as np
from vis_nav_sdk import run

import tracking_agent as T
from tracking_agent import TrackingAgent, _distance, match_wide

# ----------------------------------------------------------------------------- tunable values
CAND_PER_NODE = 12        # look at this many VLAD look-alikes for every frame
CAND_MIN_GAP = 30         # ...ignoring frames this close in the recording (they are trivially similar)
CAND_MIN_SIM = 0.0        # ...and look-alikes with a VLAD similarity below this
SEED_MIN_INLIERS = 25     # a candidate pair must first match this well (SIFT + RANSAC + spread rule)
RUN_HALF = 6              # then the frames within +-this many steps of both ends are checked as well
RUN_PAIR_MIN_INLIERS = 18 # a neighbouring pair counts as 'supporting' if it matches this well
RUN_MIN_SUPPORT = 6       # number of supporting pairs (of 2*RUN_HALF+1, seed included) needed to believe the link
LINK_WEIGHT = 2.0         # route cost of crossing a verified link (a recorded step costs 1.0)
ROUTE_BACKWARD_COST = 8.0 # walking backwards along a recording is blind (frames face the other way): last resort
ROUTE_LINK_RETRIES = 12   # verified links are trustworthy: only drop one after this many failed arrivals
LINKS_VERSION = 1         # bump to force the cache to be rebuilt
# -----------------------------------------------------------------------------------------------


def build_verified_links(n, database, feats, traj, log=print):
    """Return {(i, j): (inliers, dx)} (i < j) of links that are part of a real overlap.

    n: number of frames; database: (n, d) unit VLAD vectors; feats(i) -> (pts, desc); traj[i]: drive of frame i.
    """
    t0 = time.time()
    memo: dict[tuple[int, int], tuple[int, float]] = {}

    def m(i: int, j: int, width: float) -> tuple[int, float]:
        key = (i, j) if i < j else (j, i)
        if key not in memo:
            r = match_wide(feats(key[0]), feats(key[1]), width)
            memo[key] = r
        inl, dx = memo[key]
        return (inl, dx) if i < j else (inl, -dx)

    sim = database @ database.T
    np.fill_diagonal(sim, -2)
    for i in range(n):
        sim[i, max(0, i - CAND_MIN_GAP) : i + CAND_MIN_GAP + 1] = -2
    seeds = set()
    for i in range(n):
        for j in np.argpartition(-sim[i], CAND_PER_NODE)[:CAND_PER_NODE]:
            if sim[i, j] > CAND_MIN_SIM:
                seeds.add((min(i, int(j)), max(i, int(j))))
    log(f"route links: {len(seeds)} candidate pairs ({time.time() - t0:.0f}s)")

    width = 320.0
    links: dict[tuple[int, int], tuple[int, float]] = {}
    ordered = sorted(seeds)
    covered: set[tuple[int, int]] = set()
    for k, (i, j) in enumerate(ordered):
        if k and k % 3000 == 0:
            log(f"  checked {k}/{len(ordered)} pairs, {len(links)} links so far ({time.time() - t0:.0f}s)")
        if (i, j) in covered:
            continue
        inl, dx = m(i, j, width)
        if inl < SEED_MIN_INLIERS:
            continue
        best: list[tuple[int, int, int, float]] = []
        for direction in (1, -1):               # same direction of travel, or the other drive going the opposite way
            ok: list[tuple[int, int, int, float]] = []
            for d in range(-RUN_HALF, RUN_HALF + 1):
                a, b = i + d, j + direction * d
                if not (0 <= a < n and 0 <= b < n) or a == b or traj[a] != traj[i] or traj[b] != traj[j]:
                    continue
                if d == 0:
                    ok.append((a, b, inl, dx))
                    continue
                inl2, dx2 = m(a, b, width)
                if inl2 >= RUN_PAIR_MIN_INLIERS:
                    ok.append((a, b, inl2, dx2))
            if len(ok) > len(best):
                best = ok
        if len(best) >= RUN_MIN_SUPPORT:
            for a, b, inl2, dx2 in best:
                key = (a, b) if a < b else (b, a)
                links[key] = (inl2, dx2 if a < b else -dx2)
                covered.add(key)
    log(f"route links: {len(links)} verified pairs kept ({time.time() - t0:.0f}s)")
    return links


class RouteAgent(TrackingAgent):
    def _build_graph(self, bounds, top_k: int) -> nx.DiGraph:
        n = len(self.database)
        graph = nx.DiGraph()
        graph.add_nodes_from(range(n))

        # 1. recorded steps (walking a FORWARD step backwards is blind, so it is expensive)
        for start, end in bounds:
            for i in range(start, end - 1):
                act = self.frames[i].action
                fw, bw = T.TEMPORAL_WEIGHT, T.TEMPORAL_WEIGHT
                if act == "FORWARD":
                    bw = ROUTE_BACKWARD_COST
                elif act == "BACKWARD":
                    fw = ROUTE_BACKWARD_COST
                graph.add_edge(i, i + 1, weight=fw)
                graph.add_edge(i + 1, i, weight=bw)

        probe = cv2.imread(str(self.frames[0].path))
        self._width = float(probe.shape[1]) if probe is not None else 640.0

        # 2. "same pose again" links inside one drive (the explorer wiggled and came back to the same view)
        rot_p = np.zeros(n + 1, int)
        fwd_p = np.zeros(n + 1, int)
        for k, f in enumerate(self.frames):
            rot_p[k + 1] = rot_p[k] + (f.action == "RIGHT") - (f.action == "LEFT")
            fwd_p[k + 1] = fwd_p[k] + (f.action == "FORWARD") - (f.action == "BACKWARD")
        same = 0
        for start, end in bounds:
            for i in range(start, end):
                for j in range(i + 2, min(end, i + T.SAME_POSE_SPAN + 1)):
                    if rot_p[j] != rot_p[i] or fwd_p[j] != fwd_p[i]:
                        continue
                    inl, dx = T.match(self._node_feats(i), self._node_feats(j))
                    if inl >= T.SAME_POSE_MIN_INLIERS and abs(dx) <= T.SAME_POSE_MAX_SHIFT:
                        graph.add_edge(i, j, weight=T.SAME_POSE_WEIGHT, visual=True, same=True, dx=dx)
                        graph.add_edge(j, i, weight=T.SAME_POSE_WEIGHT, visual=True, same=True, dx=-dx)
                        same += 1

        # 3. verified overlaps between drives / different parts of a drive (cached)
        cache = self._cache_dir / (
            f"route_links_v{LINKS_VERSION}_{n}_{CAND_PER_NODE}_{SEED_MIN_INLIERS}_{RUN_HALF}_{RUN_PAIR_MIN_INLIERS}_{RUN_MIN_SUPPORT}.json"
        )
        links = None
        if cache.exists():
            try:
                links = {(a, b): (inl, dx) for a, b, inl, dx in json.loads(cache.read_text())}
                print(f"route links: loaded {len(links)} verified pairs from {cache.name}")
            except Exception:
                links = None
        if links is None:
            traj = [f.trajectory for f in self.frames]
            links = build_verified_links(n, self.database, self._node_feats, traj)
            self._save_store()
            try:
                self._cache_dir.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps([[int(a), int(b), int(i), float(d)] for (a, b), (i, d) in links.items()]))
            except Exception as exc:
                print("could not cache links:", exc)
        for (a, b), (inl, dx) in links.items():
            w = LINK_WEIGHT + 0.5 * _distance(float(self.database[a] @ self.database[b]))
            graph.add_edge(a, b, weight=w, visual=True, dx=dx)
            graph.add_edge(b, a, weight=w, visual=True, dx=-dx)
        print(f"graph: {n} nodes, {graph.number_of_edges()} directed edges ({same} same-pose links, "
              f"{len(links)} verified overlap pairs)")
        return graph


# the tracker reads these module-level values at run time
T.BACKWARD_COST = ROUTE_BACKWARD_COST
T.LINK_RETRIES = ROUTE_LINK_RETRIES
T.STEER_ENABLED = False     # route hints come from the verified route itself (corner countdown), not from one far frame


if __name__ == "__main__":
    parser = cli.parser(__doc__)
    parser.add_argument("--data", help="exploration data directory (default: download)")
    parser.add_argument("--subsample", type=int, default=1, help="keep every Nth frame")
    parser.add_argument("--n-clusters", type=int, default=128, help="VLAD codebook size")
    parser.add_argument("--top-k", type=int, default=100, help="unused (kept for the same command line)")
    args = parser.parse_args()

    challenge = cli.challenge(args)
    agent = RouteAgent(
        cli.exploration_data(args, args.data),
        n_clusters=args.n_clusters,
        subsample=args.subsample,
        top_k_shortcuts=args.top_k,
        cache_dir=Path("cache") / challenge.replace(":", "-"),
    )
    run(agent, challenge, **cli.run_options(args))
