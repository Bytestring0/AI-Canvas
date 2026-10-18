// hunter.js
'use strict';

const HUNT_ACTIONS = ['right', 'down', 'left', 'up', 'wait'];

function huntGraph(o) {
  const w = o.width, h = o.height, n = w * h;
  const next = new Int32Array(n * 4);
  next.fill(-1);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (o.grid[y][x] !== 0) continue;

      const v = y * w + x, b = 4 * v;

      if (x + 1 < w && o.grid[y][x + 1] === 0)
        next[b] = v + 1;

      if (y + 1 < h && o.grid[y + 1][x] === 0)
        next[b + 1] = v + w;

      if (x > 0 && o.grid[y][x - 1] === 0)
        next[b + 2] = v - 1;

      if (y > 0 && o.grid[y - 1][x] === 0)
        next[b + 3] = v - w;
    }
  }

  return {w, n, next};
}

function huntBfs(graph, source) {
  const distance = new Int16Array(graph.n);
  distance.fill(-1);

  const q = new Int32Array(graph.n);

  let head = 0, tail = 1;

  q[0] = source;
  distance[source] = 0;

  while (head < tail) {
    const v = q[head++];

    for (let a = 0; a < 4; a++) {
      const u = graph.next[4 * v + a];

      if (
        u >= 0 &&
        distance[u] === -1
      ) {
        distance[u] = distance[v] + 1;
        q[tail++] = u;
      }
    }
  }

  return distance;
}

function huntPeriodic(o, graph) {
  const gate = new Array(graph.n);
  const trap = new Array(graph.n);

  for (const v of o.gates) {
    gate[v.y * graph.w + v.x] = {
      period: v.period,
      on: v.on,
      phase: ((v.phase % v.period) + v.period) % v.period
    };
  }

  for (const v of o.traps) {
    trap[v.y * graph.w + v.x] = {
      period: v.period,
      on: v.on,
      phase: ((v.phase % v.period) + v.period) % v.period
    };
  }

  return {gate, trap};
}

function huntActive(v, tick) {
  return v !== undefined &&
    (tick + v.phase) % v.period < v.on;
}

function huntForecast(
  o,
  graph,
  periodic,
  distKey,
  distExit,
  hunterDists
) {
  const n = graph.n;
  const w = graph.w;
  const horizon = 12;

  const pos = v => v.y * w + v.x;

  const player = pos(o.player);
  const exit = pos(o.exit);
  const key = o.key ? pos(o.key) : -1;

  const coin = new Uint8Array(n);

  for (const v of o.coins) {
    coin[pos(v)] = 1;
  }

  const prev =
    o.memory && typeof o.memory === 'object'
      ? o.memory
      : {};

  // Player displacement between hunter decisions,
  // not necessarily between consecutive ticks.
  const vx =
    Number.isInteger(prev.px)
      ? o.player.x - prev.px
      : 0;

  const vy =
    Number.isInteger(prev.py)
      ? o.player.y - prev.py
      : 0;

  // Separate probability distributions for
  // states before and after collecting the key.
  let without = new Float64Array(n);
  let withKey = new Float64Array(n);

  if (o.player.hasKey || key < 0) {
    withKey[player] = 1;
  } else {
    without[player] = 1;
  }

  const forecasts = [new Float32Array(n)];
  forecasts[0][player] = 1;

  const every = Math.max(1, o.hunterEvery);

  for (let s = 1; s <= horizon; s++) {
    const tick = o.tick + s - 1;

    const newWithout = new Float64Array(n);
    const newWith = new Float64Array(n);

    for (let mode = 0; mode < 2; mode++) {
      const src =
        mode === 0 ? without : withKey;

      const destinationDist =
        mode === 0 ? distKey : distExit;

      for (let v = 0; v < n; v++) {
        const mass = src[v];

        if (mass < 1e-9) continue;

        const oldD = destinationDist[v];

        let hasForward = false;

        for (let a = 0; a < 4; a++) {
          const u = graph.next[4 * v + a];

          if (
            u >= 0 &&
            !huntActive(periodic.gate[u], tick) &&
            destinationDist[u] < oldD
          ) {
            hasForward = true;
            break;
          }
        }

        const ids = [];
        const weights = [];

        let weightSum = 0;

        for (let a = 0; a < 5; a++) {
          const u =
            a === 4 ? v : graph.next[4 * v + a];

          if (
            u < 0 ||
            (
              a !== 4 &&
              huntActive(periodic.gate[u], tick)
            )
          ) {
            continue;
          }

          const newlyKeyed =
            mode === 0 && u === key;

          // Reaching the exit with a key ends the
          // world before a hunter can deal damage.
          if (
            (mode === 1 || newlyKeyed) &&
            u === exit
          ) {
            continue;
          }

          const newD = destinationDist[u];

          // Approximate runner policy:
          // prefer progress, but retain probability
          // for detours, evasion and waiting.
          let weight =
            a === 4
              ? hasForward ? 0.12 : 0.9
              : newD < oldD
                ? 4.2
                : newD === oldD
                  ? 0.6
                  : 0.32;

          if (coin[u]) {
            weight *= 1.7;
          }

          if (
            huntActive(periodic.trap[u], tick) &&
            tick >= o.player.invulnerableUntil
          ) {
            weight *= 0.09;
          }

          // A cautious player may avoid cells
          // that nearby hunters could occupy.
          if (
            s <= 3 &&
            tick >= o.player.invulnerableUntil
          ) {
            const canMove =
              1 + Math.floor((s - 1) / every);

            let nearest = Infinity;

            for (const d of hunterDists) {
              if (
                d[u] >= 0 &&
                d[u] < nearest
              ) {
                nearest = d[u];
              }
            }

            if (nearest <= canMove) {
              weight *= s === 1 ? 0.22 : 0.44;
            } else if (nearest === canMove + 1) {
              weight *= 0.72;
            }
          }

          // Use observed movement as a weak
          // directional predictor on the first step.
          if (
            s === 1 &&
            a < 4 &&
            (vx !== 0 || vy !== 0)
          ) {
            const dx =
              (u % w) - (v % w);

            const dy =
              Math.floor(u / w) -
              Math.floor(v / w);

            const dot = dx * vx + dy * vy;

            weight *=
              dot > 0 ? 1.65 :
              dot < 0 ? 0.66 : 1;
          }

          ids.push(
            u * 2 +
            (mode === 1 || newlyKeyed ? 1 : 0)
          );

          weights.push(weight);
          weightSum += weight;
        }

        if (weightSum <= 0) continue;

        const scale = mass / weightSum;

        for (let a = 0; a < ids.length; a++) {
          const entry = ids[a];
          const u = entry >> 1;

          if (entry & 1) {
            newWith[u] += scale * weights[a];
          } else {
            newWithout[u] += scale * weights[a];
          }
        }
      }
    }

    without = newWithout;
    withKey = newWith;

    const sum = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      sum[i] = without[i] + withKey[i];
    }

    forecasts.push(sum);
  }

  return forecasts;
}

function decide(observation) {
  const o = observation;

  const graph = huntGraph(o);

  const w = graph.w;
  const n = graph.n;

  const pos = p => p.y * w + p.x;

  const player = pos(o.player);
  const exit = pos(o.exit);

  const key =
    o.key ? pos(o.key) : exit;

  const distKey = huntBfs(graph, key);
  const distExit = huntBfs(graph, exit);
  const fromPlayer = huntBfs(graph, player);

  const hunterDists = o.hunters.map(
    h => huntBfs(graph, pos(h))
  );

  const periodic = huntPeriodic(o, graph);

  // Predict possible player locations for 12
  // future runner steps.
  const forecast = huntForecast(
    o,
    graph,
    periodic,
    distKey,
    distExit,
    hunterDists
  );

  const frameTimes = [2, 4, 7, 11];
  const frameWeights = [0.34, 0.31, 0.22, 0.13];

  const validMoves = [];

  // Share BFS results among candidate moves that
  // lead to the same square.
  const cachedDists = new Map();

  function distanceFrom(v) {
    if (!cachedDists.has(v)) {
      cachedDists.set(
        v,
        huntBfs(graph, v)
      );
    }

    return cachedDists.get(v);
  }

  // Generate legal candidates for every hunter.
  for (const hunter of o.hunters) {
    const current = pos(hunter);
    const choices = [];

    for (let a = 0; a < 5; a++) {
      const v =
        a === 4
          ? current
          : graph.next[4 * current + a];

      if (
        v < 0 ||
        (
          a !== 4 &&
          huntActive(periodic.gate[v], o.tick)
        )
      ) {
        continue;
      }

      const d = distanceFrom(v);

      let futureDistance = 0;
      let predictedMass = 0;

      // Reward proximity to the runner's
      // predicted future positions.
      for (let j = 0; j < frameTimes.length; j++) {
        const positions = forecast[frameTimes[j]];
        const fw = frameWeights[j];

        for (let u = 0; u < n; u++) {
          if (positions[u] < 1e-8) continue;

          futureDistance +=
            fw * positions[u] * d[u];

          predictedMass +=
            fw * positions[u];
        }
      }

      const chase = fromPlayer[v];

      const pressure =
        -5.2 * futureDistance -
        0.65 * chase * predictedMass;

      choices.push({
        id: hunter.id,
        action: HUNT_ACTIONS[a],
        cell: v,
        d,
        pressure
      });
    }

    validMoves.push(choices);
  }

  const chosen = new Array(o.hunters.length);

  let bestScore = -Infinity;
  let bestActions = null;

  const hpFactor =
    o.player.hp === 1 ? 850 :
    o.player.hp === 2 ? 620 : 470;

  function evaluate() {
    let score = 0;
    let collisionChance = 0;
    let duplicates = 0;

    // Immediate contact probability is counted
    // once for each unique occupied cell.
    // Several hunters hitting simultaneously
    // still cause only one HP of damage.
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];

      score += c.pressure;

      let seen = false;

      for (let j = 0; j < i; j++) {
        if (chosen[j].cell === c.cell) {
          seen = true;
          break;
        }
      }

      if (seen) {
        duplicates++;
      } else {
        collisionChance +=
          forecast[1][c.cell];
      }
    }

    score +=
      hpFactor * collisionChance -
      7 * duplicates;

    // Evaluate joint future coverage.
    // A square is covered if at least one hunter
    // can potentially reach it in the available
    // number of hunter turns.
    let forecastCoverage = 0;

    for (let j = 0; j < frameTimes.length; j++) {
      const s = frameTimes[j];
      const positions = forecast[s];

      const futureMoves =
        Math.floor((s - 1) / o.hunterEvery);

      let coverage = 0;

      for (let u = 0; u < n; u++) {
        const probability = positions[u];

        if (probability < 1e-7) continue;

        let nearest = 1000;

        for (const c of chosen) {
          if (
            c.d[u] >= 0 &&
            c.d[u] < nearest
          ) {
            nearest = c.d[u];
          }
        }

        if (nearest <= futureMoves) {
          coverage += probability;
        } else if (nearest === futureMoves + 1) {
          coverage +=
            0.23 * probability;
        }
      }

      forecastCoverage +=
        frameWeights[j] * coverage;
    }

    score += 118 * forecastCoverage;

    if (score > bestScore + 1e-9) {
      bestScore = score;

      bestActions = chosen.map(
        c => ({
          id: c.id,
          action: c.action
        })
      );
    }
  }

  // At most 5^3 = 125 joint action combinations.
  function search(i) {
    if (i === validMoves.length) {
      evaluate();
      return;
    }

    for (const move of validMoves[i]) {
      chosen[i] = move;
      search(i + 1);
    }
  }

  search(0);

  return {
    actions:
      bestActions ||
      o.hunters.map(
        h => ({
          id: h.id,
          action: 'wait'
        })
      ),

    memory: {
      px: o.player.x,
      py: o.player.y,
      tick: o.tick
    }
  };
}