// strategy.js
'use strict';

const RUN_ACTIONS = ['right', 'down', 'left', 'up', 'wait'];

function runGraph(o) {
  const w = o.width, h = o.height, n = w * h;
  const next = new Int32Array(n * 4);
  next.fill(-1);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (o.grid[y][x] !== 0) continue;

      const u = y * w + x, b = u * 4;

      if (x + 1 < w && o.grid[y][x + 1] === 0)
        next[b] = u + 1;

      if (y + 1 < h && o.grid[y + 1][x] === 0)
        next[b + 1] = u + w;

      if (x > 0 && o.grid[y][x - 1] === 0)
        next[b + 2] = u - 1;

      if (y > 0 && o.grid[y - 1][x] === 0)
        next[b + 3] = u - w;
    }
  }

  return {w, n, next};
}

function runBfs(graph, source) {
  const d = new Int16Array(graph.n);
  d.fill(-1);

  if (source < 0 || source >= graph.n) return d;

  const q = new Int32Array(graph.n);
  let head = 0, tail = 1;

  q[0] = source;
  d[source] = 0;

  while (head < tail) {
    const v = q[head++], base = 4 * v;

    for (let a = 0; a < 4; a++) {
      const u = graph.next[base + a];

      if (u >= 0 && d[u] === -1) {
        d[u] = d[v] + 1;
        q[tail++] = u;
      }
    }
  }

  return d;
}

function runPeriodic(o, n, w) {
  const gates = new Array(n);
  const traps = new Array(n);

  for (const g of o.gates) {
    gates[g.y * w + g.x] = {
      period: g.period,
      on: g.on,
      phase: ((g.phase % g.period) + g.period) % g.period
    };
  }

  for (const tr of o.traps) {
    traps[tr.y * w + tr.x] = {
      period: tr.period,
      on: tr.on,
      phase: ((tr.phase % tr.period) + tr.period) % tr.period
    };
  }

  return {gates, traps};
}

function runActive(p, tick) {
  return p !== undefined &&
    ((tick + p.phase) % p.period) < p.on;
}

class RunHeap {
  constructor() {
    this.nodes = [];
    this.priorities = [];
    this.costs = [];
  }

  push(node, priority, cost) {
    const ns = this.nodes;
    const ps = this.priorities;
    const cs = this.costs;

    let i = ns.length;

    ns.push(node);
    ps.push(priority);
    cs.push(cost);

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (ps[parent] <= priority) break;

      ns[i] = ns[parent];
      ps[i] = ps[parent];
      cs[i] = cs[parent];

      i = parent;
    }

    ns[i] = node;
    ps[i] = priority;
    cs[i] = cost;
  }

  pop() {
    const ns = this.nodes;
    const ps = this.priorities;
    const cs = this.costs;

    const result = [ns[0], cs[0]];

    const node = ns.pop();
    const priority = ps.pop();
    const cost = cs.pop();

    if (ns.length) {
      let i = 0;
      const length = ns.length;

      while (true) {
        const l = i * 2 + 1;

        if (l >= length) break;

        const r = l + 1;
        const child =
          r < length && ps[r] < ps[l] ? r : l;

        if (ps[child] >= priority) break;

        ns[i] = ns[child];
        ps[i] = ps[child];
        cs[i] = cs[child];

        i = child;
      }

      ns[i] = node;
      ps[i] = priority;
      cs[i] = cost;
    }

    return result;
  }

  get length() {
    return this.nodes.length;
  }
}

function runRisk(o, graph, hunterDists, horizon, stagnation) {
  const n = graph.n;
  const length = Math.min(horizon, 13);
  const risk = new Float32Array(length * n);

  if (hunterDists.length === 0) return risk;

  const baselineMoves =
    Math.floor(o.tick / o.hunterEvery);

  let severity =
    o.player.hp === 1 ? 2.5 :
    o.player.hp === 2 ? 1.2 : 0.9;

  if (stagnation >= 5) severity *= 0.65;
  if (stagnation >= 9) severity *= 0.5;

  for (let k = 0; k < length; k++) {
    const time = o.tick + k;

    if (time < o.player.invulnerableUntil) continue;

    const turns =
      Math.floor((time + 1) / o.hunterEvery) -
      baselineMoves;

    const decay = 1 / (1 + 0.28 * k);
    const offset = k * n;

    for (let v = 0; v < n; v++) {
      let highest = 0;
      let total = 0;

      for (let j = 0; j < hunterDists.length; j++) {
        const d = hunterDists[j][v];

        if (d < 0) continue;

        let r = 0;

        if (d <= turns) {
          r = (d === 0 ? 105 : 77) * decay;
        } else if (d === turns + 1) {
          r = 15 * decay;
        } else if (d === turns + 2) {
          r = 2.5 * decay;
        }

        total += r;

        if (r > highest) highest = r;
      }

      risk[offset + v] =
        severity * (highest + 0.15 * (total - highest));
    }
  }

  return risk;
}

function runPlan(
  o,
  graph,
  source,
  goal,
  dist,
  periodic,
  hunterDists,
  stagnation
) {
  if (source === goal) return 'wait';
  if (dist[source] < 0) return 'wait';

  const n = graph.n;
  const remaining = o.maxTicks - o.tick;

  const horizon = Math.min(
    remaining,
    Math.max(32, dist[source] + 28),
    160
  );

  if (horizon <= 0) return 'wait';

  const risk = runRisk(
    o, graph, hunterDists, horizon, stagnation
  );

  const riskHorizon = risk.length / n;

  const best = new Float64Array((horizon + 1) * n);
  best.fill(Infinity);

  const first = new Uint8Array(best.length);
  const heap = new RunHeap();

  best[source] = 0;
  heap.push(source, 1.07 * dist[source], 0);

  let expanded = 0;
  let bestFrontier = -1;
  let frontierDistance = Infinity;
  let frontierCost = Infinity;

  const maxExpanded = 24000;

  while (heap.length && expanded < maxExpanded) {
    const entry = heap.pop();

    const state = entry[0];
    const cost = entry[1];

    if (cost !== best[state]) continue;

    const step = Math.floor(state / n);
    const v = state - step * n;

    if (v === goal) {
      return RUN_ACTIONS[first[state]];
    }

    if (
      step !== 0 &&
      (
        dist[v] < frontierDistance ||
        (
          dist[v] === frontierDistance &&
          cost < frontierCost
        )
      )
    ) {
      bestFrontier = state;
      frontierDistance = dist[v];
      frontierCost = cost;
    }

    if (step >= horizon) continue;

    expanded++;

    const time = o.tick + step;

    for (let a = 0; a < 5; a++) {
      const u =
        a === 4 ? v : graph.next[v * 4 + a];

      if (u < 0) continue;

      // Only entering a closed gate is forbidden.
      // Waiting on a gate is legal.
      if (
        a !== 4 &&
        runActive(periodic.gates[u], time)
      ) {
        continue;
      }

      const nextStep = step + 1;
      const nextState = nextStep * n + u;

      let surcharge = 0;

      // Reaching the exit with the key wins before
      // any trap or hunter damage is applied.
      const winsNow =
        o.player.hasKey &&
        u === o.exit.y * graph.w + o.exit.x;

      if (!winsNow) {
        if (runActive(periodic.traps[u], time)) {
          surcharge +=
            time < o.player.invulnerableUntil
              ? 0
              : o.player.hp === 1
                ? 175
                : o.player.hp === 2
                  ? 76
                  : 52;
        }

        if (step < riskHorizon) {
          surcharge += risk[step * n + u];
        }
      }

      // Prevent repeated replanning from treating
      // indefinite waiting as a free escape.
      const waitTax =
        a === 4
          ? stagnation >= 9
            ? 8
            : stagnation >= 5
              ? 3
              : 1.4
          : 0;

      const nextCost =
        cost + 1 + surcharge + waitTax;

      if (nextCost + 1e-8 >= best[nextState]) {
        continue;
      }

      best[nextState] = nextCost;

      first[nextState] =
        step === 0 ? a : first[state];

      heap.push(
        nextState,
        nextCost + 1.07 * dist[u],
        nextCost
      );
    }
  }

  // If the search horizon or expansion budget is
  // exhausted, continue toward the best frontier.
  if (bestFrontier >= 0) {
    return RUN_ACTIONS[first[bestFrontier]];
  }

  // Last-resort legal one-step selection.
  let choice = 'wait';
  let minScore = Infinity;

  for (let a = 0; a < 5; a++) {
    const v =
      a === 4 ? source : graph.next[source * 4 + a];

    if (
      v < 0 ||
      (
        a !== 4 &&
        runActive(periodic.gates[v], o.tick)
      )
    ) {
      continue;
    }

    const r = riskHorizon ? risk[v] : 0;

    const trap =
      runActive(periodic.traps[v], o.tick) &&
      o.tick >= o.player.invulnerableUntil
        ? 110
        : 0;

    const score =
      dist[v] * 3 +
      r +
      trap +
      (a === 4 ? 1 : 0);

    if (score < minScore) {
      minScore = score;
      choice = RUN_ACTIONS[a];
    }
  }

  return choice;
}

function decide(observation) {
  const o = observation;

  const graph = runGraph(o);
  const n = graph.n;
  const w = graph.w;

  const pos = p => p.y * w + p.x;

  const player = pos(o.player);
  const exit = pos(o.exit);

  const prev =
    o.memory && typeof o.memory === 'object'
      ? o.memory
      : {};

  const stagnation =
    prev.px === o.player.x &&
    prev.py === o.player.y
      ? Math.min(
          20,
          (
            Number.isInteger(prev.stagnation)
              ? prev.stagnation
              : 0
          ) + 1
        )
      : 0;

  const fromPlayer = runBfs(graph, player);
  const exitDist = runBfs(graph, exit);

  const needKey =
    !o.player.hasKey && o.key !== null;

  const primary =
    needKey ? pos(o.key) : exit;

  const toPrimary =
    needKey ? runBfs(graph, primary) : exitDist;

  const hunterDists = o.hunters.map(
    h => runBfs(graph, pos(h))
  );

  const baseDist = toPrimary[player];
  const remaining = o.maxTicks - o.tick;

  const shortestFinish =
    baseDist +
    (needKey ? exitDist[primary] : 0);

  let selectedCoin = -1;
  let bestCoinValue = -Infinity;

  // Coin detours become smaller on harder maps.
  // With one HP, only zero-detour coins qualify.
  let allowance =
    o.player.hp <= 1
      ? 0
      : o.hunters.length >= 3
        ? 4
        : o.hunters.length === 2
          ? 5
          : 7;

  if (stagnation >= 7) {
    allowance = 0;
  }

  if (
    shortestFinish < 0 ||
    remaining <= shortestFinish + 12
  ) {
    allowance = 0;
  } else {
    allowance = Math.min(
      allowance,
      Math.max(
        0,
        Math.floor(
          (remaining - shortestFinish - 8) / 3
        )
      )
    );
  }

  // Select an optional coin waypoint that stays
  // close to a route toward the required objective.
  for (const coin of o.coins) {
    const v = pos(coin);

    const toCoin = fromPlayer[v];
    const onward = toPrimary[v];

    if (
      toCoin < 0 ||
      onward < 0 ||
      baseDist < 0
    ) {
      continue;
    }

    const detour =
      toCoin + onward - baseDist;

    if (
      detour > allowance ||
      toCoin > 24
    ) {
      continue;
    }

    let nearby = 1000;

    for (const hd of hunterDists) {
      if (
        hd[v] >= 0 &&
        hd[v] < nearby
      ) {
        nearby = hd[v];
      }
    }

    const danger =
      nearby <= 1 ? 32 :
      nearby <= 3 ? 16 :
      nearby <= 5 ? 5 : 0;

    // Hysteresis reduces coin-target oscillation.
    const inertia =
      v === prev.coin ? 9 : 0;

    const value =
      49 -
      7 * detour -
      0.8 * toCoin -
      danger +
      inertia;

    if (
      value > bestCoinValue &&
      value > 0
    ) {
      selectedCoin = v;
      bestCoinValue = value;
    }
  }

  const target =
    selectedCoin >= 0
      ? selectedCoin
      : primary;

  const distances =
    target === primary
      ? toPrimary
      : runBfs(graph, target);

  const periodic = runPeriodic(o, n, w);

  const action = runPlan(
    o,
    graph,
    player,
    target,
    distances,
    periodic,
    hunterDists,
    stagnation
  );

  return {
    action,
    memory: {
      px: o.player.x,
      py: o.player.y,
      stagnation,
      coin: selectedCoin
    }
  };
}