/* ==========================================================================
 * hunter.js  --  chaser policy for the "maze-1" protocol.
 *
 * The script is called only when (tick + 1) % hunterEvery === 0 and must answer
 * for every hunter id exactly once.  It is deterministic, synchronous and uses
 * no wall clock and no randomness.
 *
 * Per hunter, per call:
 *   arrivals : exact BFS-in-one-tick arrival field of the *player* (gates
 *              included).  A hunter whose path time to the player exceeds the
 *              player's own arrival time is not on an intercept, it is on a
 *              chase, and that is the case the plans are designed to win.
 *   plans    : four weighted plan fields -- intercept, lead(+k), camp(exit) and
 *              trail(coins).  Each is one deterministic Dijkstra run.
 *   rollout  : each plan is walked forward with the real hunterEvery cadence and
 *              the real damage rule, scoring the tick of the hit and charging
 *              for time spent trailing too far behind.
 *   memory   : {p:{id:planIndex}} so a hunter stays committed between calls.
 *
 * Safety: for every id in o.hunters exactly one entry comes back, ids are
 * preserved, and every action is re-validated against walls and closed gates.
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
/* Plan slot 3 is the "chase tail" plan: walk against the player's real
   shortest-path ordering.  Pure chase closes distance; the tail plan sits on
   the far side of the player's own escape tree, which is how a slower chaser
   still cuts somebody off. */
var LONG_PLAN = 3;

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

function enterable(m, id, arrive) {
  if (m.solid[id]) return false;
  var gi = m.gateRef[id];
  if (gi < 0) return true;
  return !gateClosed(m.gates[gi], arrive);
}

/* Exact arrival field of a mover that takes one step per tick. */
function bfsInTick(m, start, tick) {
  var N = m.N, W = m.W;
  var dist = new Int16Array(N).fill(-1);
  var q = new Int32Array(N);
  var qh = 0, qt = 0;
  if (start < 0 || start >= N || m.solid[start]) return dist;
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
      if (dist[n] >= 0) continue;
      if (!enterable(m, n, tick + d)) continue;
      dist[n] = d + 1;
      q[qt++] = n;
    }
  }
  return dist;
}

/* Static distance field, used for connectivity tests only. */
function staticBfs(m, start) {
  var N = m.N, W = m.W;
  var dist = new Int16Array(N).fill(-1);
  var q = new Int32Array(N);
  var qh = 0, qt = 0;
  if (start < 0 || start >= N || m.solid[start]) return dist;
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
      if (dist[n] >= 0 || m.solid[n]) continue;
      dist[n] = d + 1;
      q[qt++] = n;
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
/* Plan fields                                                        */
/* ------------------------------------------------------------------ */

/* Cost of entering cell `id` when the hunter is building plan `pi`.
 *
 * The hunter is slower than the player (one step every hunterEvery ticks), so a
 * pure chase from behind is lost.  The two plays that do work against a faster
 * target are:
 *   - standing on a cell the player must cross (arrival discount), and
 *   - never giving ground (anything farther from the player than the hunter's
 *     own distance is priced up), which converts a lost chase into a block.
 * Plans 2 and 3 are positional: camp the objective, sit on the route the
 * player must take next. */
function cellCost(m, id, arrivals, pi, myDist) {
  var a = arrivals[id];
  var c = 1;
  if (pi === 0) {                     /* chase: straight at the player */
    if (a >= 0) c += (a >= myDist) ? 0 : 3;   /* standing on his route helps */
  } else if (pi === 1) {              /* lead: stand ahead of the player */
    if (a >= 0) c += a >= myDist + LEAD ? -4 : (myDist <= 2 ? -2 : 2);
  } else if (pi === LONG_PLAN) {      /* chase tail: sit on his longest path */
    c += 0;
  } else {                            /* camp: the exit / the next choke */
    c += 0;
  }
  if (m.gateRef[id] >= 0) c += 2;     /* do not queue on doors */
  return c < 1 ? 1 : c;
}

/* One deterministic Dijkstra/A* per call.  `myField` and `toTarget` are
   distance fields computed once per hunter and shared by all four plans; the
   exact potential makes the search stop as soon as the target is popped, so a
   full-map plan costs a fraction of a full Dijkstra. */
/* One deterministic Dijkstra/A* per call.  `myField` and `toTarget` are
   distance fields computed once per hunter (and once per target) and shared by
   all four plans; the exact potential makes the search stop as soon as the
   target is popped, so a full-map plan costs a fraction of a full Dijkstra. */
function planField(m, start, arrivals, tick, pi, target, myField, toTarget) {
  var N = m.N;
  if (start < 0 || start >= N || m.solid[start]) return null;
  if (target < 0 || target >= N) return null;
  if (toTarget[start] < 0) return null;            /* unreachable, skip it */
  var best = new Float64Array(N).fill(INF_C);
  var parent = new Int32Array(N).fill(-2);
  var done = new Uint8Array(N);
  var heap = new Int32Array(N + 8);
  var keys = new Float64Array(N + 8);
  var n = 0;
  best[start] = 0;
  parent[start] = -1;
  n = push(heap, keys, n, start, toTarget[start]);
  var myDist = myField;
  if (!myDist) myDist = staticBfs(m, start);

  while (n > 0) {
    var cur = heap[0];
    if (done[cur]) { n = pop(heap, keys, n); continue; }
    n = pop(heap, keys, n);
    done[cur] = 1;
    if (cur === target) break;                 /* the plan path is settled */
    var gc = best[cur];
    var x = cur % m.W, y = (cur - x) / m.W;
    for (var k = 0; k < 4; k++) {
      var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
      var nid = ny * m.W + nx;
      if (m.solid[nid] || done[nid]) continue;
      if (!enterable(m, nid, tick)) continue;
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
  return { best: best, parent: parent };
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
/* Rollout                                                           */
/* ------------------------------------------------------------------ */

/* Walk the plan with the real cadence: the hunter steps at tick t+1, t+1+every,
   ... and the hit is judged after the player's move on the same tick, so
   reaching the player's cell by tick t counts. */
function rollout(m, plan, hId, pId, arrivals, tick, horizon) {
  var cur = hId, score = 0, wasted = 0, j = 0, prev = -1;
  var pp = -1;
  while (j < horizon) {
    var nxt = plan.parent[cur];
    if (nxt === undefined || nxt === -2 || nxt === -1) break;
    if (nxt === pId) {
      /* a hit costs 1 of 3 lives and buys 3 free ticks: front-load it */
      score += 100 - j * 4;
      break;
    }
    if (nxt === prev) { score -= 6; break; }         /* a zero-length step */
    if (nxt === pp) { score -= 5; break; }           /* a two-step cycle */
    var a = arrivals[cur];
    if (a >= 0 && a <= j) wasted++;                  /* already behind him */
    pp = prev;
    prev = cur;
    cur = nxt;
    j++;
  }
  score -= wasted * 3;
  score -= j * 0.15;
  return score;
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
  if (!o || o.role !== 'hunter' || !o.player || !o.grid || !o.exit) return idle;

  var m = buildModel(o);
  var tick = m.t0;
  var W = m.W;

  var px = o.player.x | 0, py = o.player.y | 0;
  if (px < 0 || py < 0 || px >= W || py >= m.H * 1 || m.solid[py * W + px]) return idle;
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

  /* Open space around the player: with room to run, cut anywhere; boxed in,
     only the closers matter. */
  var pPressure = 0;
  for (i = 0; i < 4; i++) {
    var nx = px + DIRS[i].dx, ny = py + DIRS[i].dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) continue;
    var nid = ny * W + nx;
    if (!m.solid[nid] && enterable(m, nid, tick)) pPressure++;
  }

  var exitId = (o.exit.y | 0) * W + (o.exit.x | 0);

  /* Three targets that do not depend on the player's live position:
     the exit (where every runner must finish), the choke point a few ticks
     ahead on the player's own route, and the far end of his escape tree. */
  var exitField = staticBfs(m, exitId);
  var exitOk = exitField[pId] >= 0 && exitField[pId] <= 200;
  var chokeId = -1;
  var chokeBest = INF_C;
  var longId = pId, longBest = -1;
  for (i = 0; i < m.N; i++) {
    var pa = arrivals[i];
    if (pa < 0) continue;
    if (m.solid[i]) continue;
    if (pa >= 2 && pa <= 7) {
      var deg = 0;
      for (var q = 0; q < 4; q++) {
        var qx = (i % W) + DIRS[q].dx, qy = ((i - i % W) / W) + DIRS[q].dy;
        if (qx < 0 || qy < 0 || qx >= W || qy >= m.H) continue;
        if (!m.solid[qy * W + qx] && enterable(m, qy * W + qx, tick)) deg++;
      }
      var score = pa * 10 - deg * 6;
      if (score < chokeBest || (score === chokeBest && i < chokeId)) {
        chokeBest = score;
        chokeId = i;
      }
    }
    if (pa > longBest) { longBest = pa; longId = i; }
  }

  var actions = [];
  var newMem = { p: {} };
  var h, id, hx, hy, hId, prev, targets, bestScore, bestAction, bestPlan, pi, pl, nxt, sc;
  var myField, tf, tg;
  /* Target fields are computed at most once per call and shared by every
     hunter that plans towards the same cell. */
  var fieldCache = {};
  function targetField(t) {
    if (fieldCache[t]) return fieldCache[t];
    var f = staticBfs(m, t);
    fieldCache[t] = f;
    return f;
  }

  for (h = 0; h < hs.length; h++) {
    id = hs[h].id;
    hx = hs[h].x | 0;
    hy = hs[h].y | 0;
    if (hx < 0 || hy < 0 || hx >= W || hy >= m.H || m.solid[hy * W + hx]) {
      actions.push({ id: id, action: 'wait' });
      continue;
    }
    hId = hy * W + hx;
    prev = prevPlan[String(id)];

    /* Target cell per plan flavour. */
    targets = [pId, pId, exitOk ? exitId : (chokeId >= 0 ? chokeId : pId), longId];

    bestScore = -INF_C;
    bestAction = 'wait';
    bestPlan = 0;
    /* One static field per hunter, shared target fields: with the exact A*
       potential each plan stops at its target instead of flooding the map. */
    myField = staticBfs(m, hId);

    for (pi = 0; pi < PLANS; pi++) {
      tg = targets[pi];
      tf = targetField(tg);
      pl = planField(m, hId, arrivals, tick, pi, tg, myField, tf);
      if (!pl) continue;
      nxt = pl.parent[hId];
      if (nxt === -2 || nxt === -1) continue;
      sc = rollout(m, pl, hId, pId, arrivals, tick, horizon);
      if (pi === 0) sc += 2;                        /* chase by default */
      if (pi === 1) sc += 1;
      if (prev === pi) sc += 1.5;                   /* stay committed */
      if (pPressure >= 3 && pi !== 2) sc += 0.5;    /* room to cut off */
      if (pPressure <= 1 && pi === 0) sc += 1;      /* boxed in: close */
      if (sc > bestScore) {
        bestScore = sc;
        bestPlan = pi;
        bestAction = fromTo(m, hId, nxt);
      }
    }

    bestAction = validate(m, hId, bestAction, tick);
    newMem.p[String(id)] = bestPlan;
    actions.push({ id: id, action: bestAction });
  }

  return { actions: actions, memory: newMem };
}

function fromTo(m, from, to) {
  if (to === undefined || to === -2 || to === -1) return 'wait';
  var W = m.W;
  var fx = from % W, fy = (from - fx) / W;
  var tx = to % W, ty = (to - tx) / W;
  var dx = tx - fx, dy = ty - fy;
  for (var i = 0; i < 4; i++) {
    if (DIRS[i].dx === dx && DIRS[i].dy === dy) return DIRS[i].action;
  }
  return 'wait';
}

/* Final gate: an action must be a single step onto an enterable neighbour. */
function validate(m, from, action, tick) {
  if (action === 'wait') return 'wait';
  var W = m.W;
  var fx = from % W, fy = (from - fx) / W;
  for (var i = 0; i < 4; i++) {
    if (DIRS[i].action !== action) continue;
    var nx = fx + DIRS[i].dx, ny = fy + DIRS[i].dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) return 'wait';
    var nid = ny * W + nx;
    if (!enterable(m, nid, tick)) return 'wait';
    return action;
  }
  return 'wait';
}
