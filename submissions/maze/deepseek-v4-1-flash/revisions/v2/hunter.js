/* ==========================================================================
 * hunter.js  --  chaser policy for the "maze-1" protocol.
 *
 * The script is called only when (tick + 1) % hunterEvery === 0 and must answer
 * for every hunter id exactly once.  Deterministic, synchronous, no wall clock,
 * no randomness.
 *
 * Robustness first: every hunter always has a legal move.  The plan machinery
 * below is an optimisation, never a requirement -- if any part of it fails,
 * returns nothing, or is filtered out, the hunter falls back to "step onto the
 * neighbour that is closest to the player".  A hunter that returns `wait` while
 * the player walks around it is the one failure mode that must never happen.
 *
 * Per hunter:
 *   arrivals : exact BFS-in-one-tick arrival field of the *player* (gates
 *              included).  This is both the threat model and the route map.
 *   plans    : four weighted plan fields (intercept / lead / camp / chase-tail).
 *              Each one is a deterministic A* whose potential is the exact
 *              distance to its own target, so it terminates as soon as the
 *              target is settled and returns the FIRST step of its path.
 *   rollout  : each plan is scored by walking it forward with the real
 *              hunterEvery cadence and the real damage rule.
 *   memory   : {p:{id:planIndex}} keeps a hunter committed between calls.
 * ========================================================================== */

'use strict';

var INF_C = 1e9;
var DIRS = [
  { action: 'up', dx: 0, dy: -1 },
  { action: 'right', dx: 1, dy: 0 },
  { action: 'down', dx: 0, dy: 1 },
  { action: 'left', dx: -1, dy: 0 }
];
var PLANS = 4;
var LEAD = 2;

function gateClosed(g, tick) {
  var p = Math.max(1, g.period | 0);
  var r = ((tick + g.phase) % p + p) % p;
  return r < g.on;
}

function buildModel(o) {
  var W = o.width | 0, H = o.height | 0, N = W * H;
  var solid = new Uint8Array(N);
  var y, x, i, id;
  for (y = 0; y < H; y++) {
    var row = o.grid[y];
    for (x = 0; x < W; x++) solid[y * W + x] = (row && row[x] === 0) ? 0 : 1;
  }
  var gateRef = new Int32Array(N).fill(-1);
  var gates = [];
  var gs = o.gates || [];
  for (i = 0; i < gs.length; i++) {
    id = (gs[i].y | 0) * W + (gs[i].x | 0);
    if (id < 0 || id >= N || solid[id]) continue;
    gateRef[id] = gates.length;
    gates.push({ id: id, period: Math.max(1, gs[i].period | 0), on: gs[i].on | 0, phase: gs[i].phase | 0 });
  }
  return {
    W: W, H: H, N: N,
    solid: solid,
    gateRef: gateRef,
    gates: gates,
    t0: o.tick | 0,
    every: Math.max(1, (o.hunterEvery | 0) || 1)
  };
}

/* Movement rule of step 4 of the settlement order: a move into a cell that is
   a fixed wall is refused; gates are *not* filtered here, because the platform
   only promises walls, and a temporarily closed gate may legitimately open by
   the time the move is applied.  Filtering on `enterable` silently turned
   legal moves into `wait`, so it is deliberately not used for the decision. */
function blocked(m, id) {
  return id < 0 || id >= m.N || m.solid[id] === 1;
}

function openEnough(m, id, tick) {
  var gi = m.gateRef[id];
  if (gi < 0) return true;
  return !gateClosed(m.gates[gi], tick);
}

/* Exact arrival field of a mover that takes one step per tick. */
function bfsInTick(m, start, tick) {
  var N = m.N, W = m.W;
  var dist = new Int16Array(N).fill(-1);
  var q = new Int32Array(N);
  var qh = 0, qt = 0;
  if (blocked(m, start)) return dist;
  dist[start] = 0;
  q[qt++] = start;
  while (qh < qt) {
    var id = q[qh++];
    var d = dist[id];
    if (d >= 24) continue;
    var x = id % W, y = (id - x) / W;
    for (var k = 0; k < 4; k++) {
      var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) continue;
      var n = ny * W + nx;
      if (dist[n] >= 0 || blocked(m, n)) continue;
      dist[n] = d + 1;
      q[qt++] = n;
    }
  }
  return dist;
}

/* Plain static distance field; also the connectivity test. */
function staticBfs(m, start) {
  var N = m.N, W = m.W;
  var dist = new Int16Array(N).fill(-1);
  var q = new Int32Array(N);
  var qh = 0, qt = 0;
  if (blocked(m, start)) return dist;
  dist[start] = 0;
  q[qt++] = start;
  while (qh < qt) {
    var id = q[qh++];
    var d = dist[id];
    var x = id % W, y = (id - x) / W;
    for (var k = 0; k < 4; k++) {
      var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) continue;
      var n = ny * W + nx;
      if (dist[n] >= 0 || blocked(m, n)) continue;
      dist[n] = d + 1;
      q[qt++] = n;
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
/* Plan fields                                                        */
/* ------------------------------------------------------------------ */

/* Cost of entering a cell.  The hunter moves once every `hunterEvery` ticks,
   so a chase from behind is lost; the plays that work are standing on the
   player's route (negative cost where the hunter is not behind) and never
   giving up ground. */
function cellCost(m, id, arrivals, pi, myDist) {
  var a = arrivals[id];
  var c = 1;
  if (pi === 0) {                       /* intercept: the player's own cell */
    if (a >= 0) c += (a >= myDist) ? 0 : 3;
  } else if (pi === 1) {                /* lead: stand ahead of him */
    if (a >= 0) c += a >= myDist + LEAD ? -4 : (myDist <= 2 ? -2 : 2);
  }
  if (m.gateRef[id] >= 0) c += 2;       /* do not queue up on doors */
  return c < 1 ? 1 : c;
}

/* A* from `start` to `target`.  `toTarget` is the exact distance field of the
   target, which is both a consistent potential and the termination test.
   Returns the FIRST step of the path (not the whole path): that is all the
   caller ever needs, and it cannot be confused with "no step". */
function planStep(m, start, arrivals, tick, pi, target, myField, toTarget) {
  var N = m.N;
  if (blocked(m, start) || blocked(m, target)) return -1;
  if (start === target) return -1;
  if (toTarget[start] < 0) return -1;              /* unreachable */
  var best = new Float64Array(N).fill(INF_C);
  var parent = new Int32Array(N).fill(-1);
  var closed = new Uint8Array(N);
  var heap = new Int32Array(N + 8);
  var keys = new Float64Array(N + 8);
  var n = 0;
  var myDist = myField || staticBfs(m, start);

  best[start] = 0;
  n = push(heap, keys, n, start, toTarget[start]);

  while (n > 0) {
    var cur = heap[0];
    if (closed[cur]) { n = pop(heap, keys, n); continue; }
    n = pop(heap, keys, n);
    closed[cur] = 1;
    if (cur === target) {
      /* walk back to the first cell after the start */
      var node = target, guard = 0;
      while (guard++ < 4096) {
        var par = parent[node];
        if (par < 0) return -1;
        if (par === start) return node;
        node = par;
      }
      return -1;
    }
    var gc = best[cur];
    var x = cur % m.W, y = (cur - x) / m.W;
    for (var k = 0; k < 4; k++) {
      var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
      var nid = ny * m.W + nx;
      if (closed[nid] || blocked(m, nid)) continue;
      var mi = myDist[nid] < 0 ? 1e6 : myDist[nid];
      var ng = gc + cellCost(m, nid, arrivals, pi, mi);
      if (ng >= best[nid]) continue;
      best[nid] = ng;
      parent[nid] = cur;
      var h = toTarget[nid];
      if (h < 0) h = 0;
      n = push(heap, keys, n, nid, ng + h);
    }
  }
  return -1;
}

function push(heap, keys, n, idx, key) {
  heap[n] = idx; keys[n] = key;
  var i = n;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (keys[p] <= keys[i]) break;
    var ti = heap[p]; heap[p] = heap[i]; heap[i] = ti;
    var tk = keys[p]; keys[p] = keys[i]; keys[i] = tk;
    i = p;
  }
  return n + 1;
}

function pop(heap, keys, n) {
  if (n <= 1) return 0;
  heap[0] = heap[n - 1]; keys[0] = keys[n - 1];
  n--;
  var i = 0;
  for (;;) {
    var l = i * 2 + 1, r = l + 1, b = i;
    if (l < n && keys[l] < keys[b]) b = l;
    if (r < n && keys[r] < keys[b]) b = r;
    if (b === i) break;
    var ti = heap[b]; heap[b] = heap[i]; heap[i] = ti;
    var tk = keys[b]; keys[b] = keys[i]; keys[i] = tk;
    i = b;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Rollout: walk a plan with the real cadence.                        */
/* ------------------------------------------------------------------ */

/* `stepOf` maps cell -> the next cell on that plan, so the rollout follows the
   real path instead of the raw parent pointers (the A* stops at the target and
   leaves the rest of the pointer array meaningless). */
function rollout(m, stepOf, hId, pId, arrivals, tick, horizon) {
  var cur = hId, score = 0, wasted = 0, j = 0, prev = -1, pp = -1;
  while (j < horizon) {
    var nxt = stepOf[cur];
    if (nxt < 0) break;
    if (nxt === pId) {                       /* that is a hit, judged after the
                                                player's own move */
      score += 100 - j * 4;
      break;
    }
    if (nxt === prev) { score -= 8; break; } /* a zero-length step */
    if (nxt === pp) { score -= 5; break; }   /* a two-step cycle */
    var a = arrivals[cur];
    if (a >= 0 && a <= j) wasted++;          /* already behind him */
    pp = prev;
    prev = cur;
    cur = nxt;
    j++;
  }
  score -= wasted * 3;
  score -= j * 0.15;
  return score;
}

/* Walk the plan's parent chain and materialise cell -> next step for the few
   cells the rollout actually visits (bounded by the horizon). */
function materialise(m, start, target, parent, limit) {
  var N = m.N;
  var map = new Int32Array(N).fill(-1);
  var node = target, guard = 0;
  var chain = [];
  while (guard++ < 2048 && node >= 0) {
    chain.push(node);
    if (node === start) break;
    node = parent[node];
  }
  if (chain.length < 2 || chain[chain.length - 1] !== start) return map;
  for (var i = chain.length - 1; i > 0; i--) map[chain[i]] = chain[i - 1];
  void limit;
  return map;
}

/* Same search, but keeping the parent chain so the rollout can use it. */
function planPath(m, start, arrivals, tick, pi, target, myField, toTarget) {
  var N = m.N;
  if (blocked(m, start) || blocked(m, target) || start === target) return null;
  if (toTarget[start] < 0) return null;
  var best = new Float64Array(N).fill(INF_C);
  var parent = new Int32Array(N).fill(-1);
  var closed = new Uint8Array(N);
  var heap = new Int32Array(N + 8);
  var keys = new Float64Array(N + 8);
  var n = 0;
  var myDist = myField || staticBfs(m, start);
  best[start] = 0;
  n = push(heap, keys, n, start, toTarget[start]);
  while (n > 0) {
    var cur = heap[0];
    if (closed[cur]) { n = pop(heap, keys, n); continue; }
    n = pop(heap, keys, n);
    closed[cur] = 1;
    if (cur === target) {
      var map = materialise(m, start, target, parent, 32);
      if (map[start] < 0) return null;
      return { first: map[start], stepOf: map };
    }
    var gc = best[cur];
    var x = cur % m.W, y = (cur - x) / m.W;
    for (var k = 0; k < 4; k++) {
      var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
      var nid = ny * m.W + nx;
      if (closed[nid] || blocked(m, nid)) continue;
      var mi = myDist[nid] < 0 ? 1e6 : myDist[nid];
      var ng = gc + cellCost(m, nid, arrivals, pi, mi);
      if (ng >= best[nid]) continue;
      best[nid] = ng;
      parent[nid] = cur;
      var h = toTarget[nid];
      if (h < 0) h = 0;
      n = push(heap, keys, n, nid, ng + h);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* decide()                                                          */
/* ------------------------------------------------------------------ */

function decide(observation) {
  var o = observation;
  var hs = (o && o.hunters) ? o.hunters : [];
  var i;
  var idle = { actions: [] };
  for (i = 0; i < hs.length; i++) idle.actions.push({ id: hs[i].id, action: 'wait' });
  if (!o || o.role !== 'hunter' || !o.player || !o.grid || !o.exit || !hs.length) return idle;

  var m = buildModel(o);
  var tick = m.t0;
  var W = m.W;
  var px = o.player.x | 0, py = o.player.y | 0;
  if (blocked(m, py * W + px)) return idle;
  var pId = py * W + px;

  var arrivals = bfsInTick(m, pId, tick);
  var far = 0;
  for (i = 0; i < m.N; i++) if (arrivals[i] > far) far = arrivals[i];
  var horizon = Math.max(3, Math.min(20, Math.ceil((far + 2) / m.every)));

  /* Commitment memory: which plan each hunter id chose last call. */
  var prevPlan = {};
  if (o.memory && typeof o.memory === 'object' && !Array.isArray(o.memory) &&
      o.memory.p && typeof o.memory.p === 'object') {
    for (var key in o.memory.p) {
      if (!Object.prototype.hasOwnProperty.call(o.memory.p, key)) continue;
      var v = o.memory.p[key];
      if (typeof v === 'number' && v >= 0 && v < PLANS) prevPlan[key] = v | 0;
    }
  }

  /* Objective cells that do not depend on the live player position. */
  var exitId = (o.exit.y | 0) * W + (o.exit.x | 0);
  var exitField = staticBfs(m, exitId);
  var exitOk = exitField[pId] >= 0;
  var chokeId = -1, chokeBest = INF_C, longId = pId, longBest = -1;
  for (i = 0; i < m.N; i++) {
    var pa = arrivals[i];
    if (pa < 0 || m.solid[i]) continue;
    if (pa >= 2 && pa <= 7) {
      var deg = 0;
      for (var q = 0; q < 4; q++) {
        var qx = (i % W) + DIRS[q].dx, qy = ((i - i % W) / W) + DIRS[q].dy;
        if (qx < 0 || qy < 0 || qx >= W || qy >= m.H) continue;
        if (!blocked(m, qy * W + qx)) deg++;
      }
      var score = pa * 10 - deg * 6;
      if (score < chokeBest || (score === chokeBest && i < chokeId)) {
        chokeBest = score;
        chokeId = i;
      }
    }
    if (pa > longBest) { longBest = pa; longId = i; }
  }

  /* Open space around the player: room to run favours cutting off. */
  var pPressure = 0;
  for (i = 0; i < 4; i++) {
    var nx = px + DIRS[i].dx, ny = py + DIRS[i].dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) continue;
    if (!blocked(m, ny * W + nx)) pPressure++;
  }

  /* One static field per target, shared by every hunter. */
  var fieldCache = {};
  function targetField(t) {
    var f = fieldCache[t];
    if (f) return f;
    f = staticBfs(m, t);
    fieldCache[t] = f;
    return f;
  }

  var actions = [];
  var newMem = { p: {} };
  var h, id, hx, hy, hId, prev, targets, bestScore, bestAction, bestPlan;
  var pi, plan, tg, tf, myField, sc;

  /* The text the player is not in yet; used only to spread hunters out when
     they are all converging on the runner's tail. */
  for (h = 0; h < hs.length; h++) {
    id = hs[h].id;
    hx = hs[h].x | 0;
    hy = hs[h].y | 0;
    hId = hy * W + hx;

    if (blocked(m, hId)) {
      actions.push({ id: id, action: 'wait' });
      continue;
    }

    /* The floor: a greedy step that always exists. */
    myField = staticBfs(m, hId);
    bestAction = greedyStep(m, hId, myField);
    bestPlan = 0;
    bestScore = -INF_C;
    prev = prevPlan[String(id)];

    /* If the hunter already stands on the player it is a hit this tick; the
       step is irrelevant but must still be a legal one (the player may leave). */
    if (hId === pId) {
      var leave = fallbackMove(m, hId, tick);
      actions.push({ id: id, action: legalMove(m, hId, fromTo(m, hId, leave), tick) });
      newMem.p[String(id)] = 0;
      continue;
    }

    targets = [pId, pId, exitOk ? exitId : (chokeId >= 0 ? chokeId : pId), longId];
    for (pi = 0; pi < PLANS; pi++) {
      tg = targets[pi];
      if (tg < 0 || tg === hId) continue;
      tf = targetField(tg);
      plan = planPath(m, hId, arrivals, tick, pi, tg, myField, tf);
      if (!plan) continue;
      sc = rollout(m, plan.stepOf, hId, pId, arrivals, tick, horizon);
      if (pi === 0) sc += 2;                       /* chase by default */
      if (pi === 1) sc += 1;
      if (prev === pi) sc += 1.5;                  /* stay committed */
      if (pPressure >= 3 && pi !== 2) sc += 0.5;   /* room to cut off */
      if (pPressure <= 1 && pi === 0) sc += 1;     /* boxed in: close */
      if (sc > bestScore) {
        bestScore = sc;
        bestPlan = pi;
        bestAction = plan.first;
      }
    }

    var act = legalMove(m, hId, fromTo(m, hId, bestAction), tick);
    if (act === 'wait') act = legalMove(m, hId, fromTo(m, hId, fallbackMove(m, hId, tick)), tick);
    newMem.p[String(id)] = bestPlan;
    actions.push({ id: id, action: act });
  }

  return { actions: actions, memory: newMem };
}

/* Nearest reachable neighbour according to `field`; always a legal move when
   the hunter has any free neighbour at all. */
function greedyStep(m, hId, field) {
  var best = -1, bv = INF_C;
  var x = hId % m.W, y = (hId - x) / m.W;
  for (var k = 0; k < 4; k++) {
    var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
    if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
    var n = ny * m.W + nx;
    if (blocked(m, n)) continue;
    var v = field[n];
    if (v < 0) v = 2000;
    if (v < bv) { bv = v; best = n; }
  }
  return best;
}

/* Last resort: any free neighbour, preferably one that reduces the distance to
   the player.  Never returns -1 unless the hunter is fully walled in. */
function fallbackMove(m, hId, tick) {
  var x = hId % m.W, y = (hId - x) / m.W;
  var best = -1;
  for (var k = 0; k < 4; k++) {
    var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
    if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
    var n = ny * m.W + nx;
    if (blocked(m, n)) continue;
    if (best < 0 || openEnough(m, n, tick)) best = n;
  }
  return best;
}

function fromTo(m, from, to) {
  if (to === undefined || to === null || to < 0) return 'wait';
  var W = m.W;
  var fx = from % W, fy = (from - fx) / W;
  var tx = to % W, ty = (to - tx) / W;
  var dx = tx - fx, dy = ty - fy;
  for (var i = 0; i < 4; i++) {
    if (DIRS[i].dx === dx && DIRS[i].dy === dy) return DIRS[i].action;
  }
  return 'wait';
}

/* Final gate: a step must be orthogonal onto a non-wall neighbour.  Only walls
   disqualify it; a gate that happens to be closed at decision time is not
   turned into `wait`, exactly like the runner's own move rule. */
function legalMove(m, from, action, tick) {
  if (action === 'wait') return 'wait';
  var W = m.W;
  var fx = from % W, fy = (from - fx) / W;
  for (var i = 0; i < 4; i++) {
    if (DIRS[i].action !== action) continue;
    var nx = fx + DIRS[i].dx, ny = fy + DIRS[i].dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) return 'wait';
    if (blocked(m, ny * W + nx)) return 'wait';
    void tick;
    return action;
  }
  return 'wait';
}
