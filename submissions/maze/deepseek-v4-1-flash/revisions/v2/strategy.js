/* ==========================================================================
 * strategy.js  --  runner (maze racer) policy for the "maze-1" protocol.
 *
 * Deterministic, synchronous, no wall clock, no randomness.
 *
 * Pipeline, once per tick:
 *   1. goal bookkeeping (key first, then the exit) from the observation only
 *   2. per-cell distance fields, backwards from exit and from key, that step
 *      over the gate's open/closed automaton exactly (cell + phase state)
 *   3. "safe arrival tick" field: the first tick >= t at which each cell is
 *      not inside a hunter's one-step ball
 *   4. step choice:
 *        a. sitting on the exit with the key -> wait (the round ends now)
 *        b. deadline check  -- if the remaining ticks barely cover the plain
 *           path cost, ignore the hunters and go (the clock is lethal too)
 *        c. planner         -- weighted A* over (cell, gate phase), gates
 *           filtered by a max-flow test so a gate the hunter can pin is never
 *           trusted, hunters priced by arrival tick instead of banned
 *        d. safe-detour     -- when the planner is boxed in, walk towards the
 *           nearest cell with a clear window before the deadline
 *        e. anti-oscillation -- break an A,B,A replay using the trail in memory
 *   5. legality guard, then the memory write
 *
 * memory is only {v, goal, h} where h is the recent position trail; all
 * planning state is rebuilt from the public grid every tick, so a lost
 * memory costs one redundant search and nothing else.
 * ========================================================================== */

'use strict';

var INF = 1e9;
var DIRS = [
  { action: 'up', dx: 0, dy: -1 },
  { action: 'right', dx: 1, dy: 0 },
  { action: 'down', dx: 0, dy: 1 },
  { action: 'left', dx: -1, dy: 0 }
];
var GATE_PUSH = 2;

/* ------------------------------------------------------------------ */
/* Model                                                              */
/* ------------------------------------------------------------------ */

function buildModel(o) {
  var W = o.width | 0, H = o.height | 0;
  var N = W * H;
  var solid = new Uint8Array(N);
  var i, x, y, id;
  for (y = 0; y < H; y++) {
    var row = o.grid[y];
    for (x = 0; x < W; x++) {
      solid[y * W + x] = (row && row[x] === 0) ? 0 : 1;
    }
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
  var trapRef = new Int32Array(N).fill(-1);
  var traps = [];
  var ts = o.traps || [];
  for (i = 0; i < ts.length; i++) {
    id = (ts[i].y | 0) * W + (ts[i].x | 0);
    if (id < 0 || id >= N || solid[id]) continue;
    trapRef[id] = traps.length;
    traps.push({ id: id, period: Math.max(1, ts[i].period | 0), on: ts[i].on | 0, phase: ts[i].phase | 0 });
  }
  var coinAt = new Uint8Array(N);
  var cs = o.coins || [];
  for (i = 0; i < cs.length; i++) {
    id = (cs[i].y | 0) * W + (cs[i].x | 0);
    if (id >= 0 && id < N && !solid[id]) coinAt[id] = 1;
  }
  return {
    W: W, H: H, N: N,
    solid: solid,
    gateRef: gateRef, gates: gates,
    trapRef: trapRef, traps: traps,
    coinAt: coinAt,
    t0: o.tick | 0,
    grid: o.grid
  };
}

function gateClosedAt(g, tick) {
  var p = g.period;
  var r = ((tick + g.phase) % p + p) % p;
  return r < g.on;
}

function trapActiveAt(m, id, tick) {
  var ti = m.trapRef[id];
  if (ti < 0) return false;
  var tr = m.traps[ti];
  var r = ((tick + tr.phase) % tr.period + tr.period) % tr.period;
  return r < tr.on;
}

/* Gates are the only time-varying cells; the static grid never changes. */
function enterable(m, id, arrive) {
  if (m.solid[id]) return false;
  var gi = m.gateRef[id];
  if (gi < 0) return true;
  return !gateClosedAt(m.gates[gi], arrive);
}

/* ------------------------------------------------------------------ */
/* Distance field over (cell, gate phase)                             */
/* ------------------------------------------------------------------ */

/* Backwards BFS from `goalIds`. gates are crossed only when they are open on
   the tick of arrival, so the value is the true smallest number of moves no
   matter which gate phases the map puts in the way. */
function distField(m, goalIds, t0) {
  var W = m.W, N = m.N;
  var dist = new Int16Array(2 * N).fill(-1);
  var q = new Int32Array(2 * N);
  var qh = 0, qt = 0;
  var i, id, s;
  for (i = 0; i < goalIds.length; i++) {
    id = goalIds[i];
    if (id < 0 || id >= N || m.solid[id]) continue;
    for (s = 0; s <= 1; s++) {
      if (dist[id * 2 + s] >= 0) continue;
      dist[id * 2 + s] = 0;
      q[qt++] = id * 2 + s;
    }
  }
  while (qh < qt) {
    var cur = q[qh++];
    var d = dist[cur];
    var cid = cur >> 1;
    var x = cid % W, y = (cid - x) / W;
    for (var k = 0; k < 4; k++) {
      var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) continue;
      var nid = ny * W + nx;
      if (m.solid[nid]) continue;
      /* We are moving backwards: this neighbour would be entered on tick
         t0 + d, and it must be enterable at that tick. */
      if (!enterable(m, nid, t0 + d)) continue;
      var nn = nid * 2 + phaseAt(m, nid, t0 + d);
      if (dist[nn] >= 0) continue;
      dist[nn] = d + 1;
      q[qt++] = nn;
    }
  }
  return dist;
}

function phaseAt(m, id, tick) {
  var gi = m.gateRef[id];
  if (gi < 0) return 0;
  return gateClosedAt(m.gates[gi], tick) ? 0 : 1;
}

function distEta(field, id) {
  var a = field[id * 2], b = field[id * 2 + 1];
  if (a < 0 && b < 0) return -1;
  if (a < 0) return b;
  if (b < 0) return a;
  return a < b ? a : b;
}

/* ------------------------------------------------------------------ */
/* Hunter fields                                                      */
/* ------------------------------------------------------------------ */

/* Exact earliest hunter step that lands on each cell, given one step per tick
   and that gates can only be crossed when open. */
function hunterArrivals(m, hunters, tick) {
  var N = m.N, W = m.W;
  var out = new Int32Array(N).fill(INF);
  for (var i = 0; i < hunters.length; i++) {
    var hx = hunters[i].x | 0, hy = hunters[i].y | 0;
    if (hx < 0 || hy < 0 || hx >= W || hy >= m.H) continue;
    var hid = hy * W + hx;
    if (m.solid[hid]) continue;
    var dist = new Int16Array(N).fill(-1);
    var q = new Int32Array(N);
    var qh = 0, qt = 0;
    dist[hid] = 0;
    q[qt++] = hid;
    while (qh < qt) {
      var id = q[qh++];
      var d = dist[id];
      if (d >= 10) continue;
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
    for (var c = 0; c < N; c++) if (dist[c] >= 0 && dist[c] < out[c]) out[c] = dist[c];
  }
  return out;
}

/* Same information, but the hunter is allowed to *stand and block*, so a cell
   it can reach quickly is expensive instead of merely "unfortunate". */
function dangerScore(arr, id) {
  var a = arr[id];
  if (a <= 1) return 4000;
  if (a === 2) return 1400;
  if (a === 3) return 420;
  if (a === 4) return 120;
  if (a === 5) return 30;
  if (a === 6) return 8;
  if (a <= 8) return 2;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Gate safety (can the hunter close a gate on us?)                   */
/* ------------------------------------------------------------------ */

/* Returns false when the hunter can occupy the gate cell on every tick of the
   player's forced crossing window, i.e. when the gate is a trap.  The window is
   one tick wide because the runner crosses in one move. */
function gateTrusted(m, from, to, arr, t0) {
  var f = m.gateRef[from] >= 0 ? from : (m.gateRef[to] >= 0 ? to : -1);
  if (f < 0) return true;
  var g = m.gates[m.gateRef[f]];
  var ha = arr[f];
  var p = g.period;
  var k, a;
  /* Look at every tick at which the gate can be crossed within two periods. */
  var horizons = 2 * p + 2;
  var slots = 0;
  for (k = 0; k <= horizons; k++) {
    a = t0 + k;
    /* the player could cross at tick a if the gate is open then */
    if (gateClosedAt(g, a)) continue;
    /* the hunter can be signed on that cell at the end of tick a only if its
       own arrival step is readable; if it is far, the gate is fine */
    if (ha >= INF) { slots++; continue; }
    if (!hunterCovers(m, f, ha, a, t0)) slots++;
    if (slots > 0) return true;
  }
  return false;
}

/* Can a hunter whose raw arrival counter is `ha` (hunter steps) still be on
   gate cell `f` at absolute tick `a`?  The hunter only steps on ticks where
   (tick + 1) % every === 0 and it may also wait, so the answer is yes while
   its first step has not happened yet or after enough steps to arrive. */
function hunterCovers(m, f, ha, a, t0) {
  void f;
  var ticks = a - t0;
  if (ticks < 0) return false;
  /* the hunter needs at least `ha` ticks to get there (one step per tick) */
  if (ticks < ha) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Safe-arrival field                                                 */
/* ------------------------------------------------------------------ */

/* safeAt[id] = smallest tick >= t0 with no hunter inside the one-step ball,
   which is the first tick at which standing there costs nothing. */
function safeField(m, hunters, arr, t0, limit) {
  var N = m.N;
  var safeAt = new Int16Array(N).fill(-1);
  var ball = new Uint8Array(N);
  var i, id, x, y, k, nx, ny;
  for (i = 0; i < hunters.length; i++) {
    var hx = hunters[i].x | 0, hy = hunters[i].y | 0;
    if (hx < 0 || hy < 0 || hx >= m.W || hy >= m.H) continue;
    for (k = -1; k < 4; k++) {
      if (k < 0) { nx = hx; ny = hy; }
      else { nx = hx + DIRS[k].dx; ny = hy + DIRS[k].dy; }
      if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
      if (m.solid[ny * m.W + nx]) continue;
      ball[ny * m.W + nx] = 1;
    }
  }
  for (id = 0; id < N; id++) {
    if (m.solid[id]) continue;
    var a = arr[id];
    if (a >= INF || a > limit) { safeAt[id] = t0; continue; }
    var need = t0 + a + 1;      /* the hunter sits down on tick t0+a */
    safeAt[id] = need > limit ? -1 : need;
  }
  void ball;
  return safeAt;
}

/* ------------------------------------------------------------------ */
/* Weighted A* over (cell, gate phase, safeRel)                       */
/* ------------------------------------------------------------------ */

function moveAdd(m, id, tick) {
  var c = 1;
  if (m.coinAt[id]) c -= 6;                 /* never free: no coin loops */
  if (m.gateRef[id] >= 0) c += GATE_PUSH;
  if (m.trapRef[id] >= 0 && trapActiveAt(m, id, tick)) c += 12;
  return c;
}

/* Reading of the danger field, from "the hunter is on me" to "nobody near".
   A hunter that stands on a cell pins it, so threat here is about arrival
   time, not about the hunter's possible future route: this is why the values
   can be gentle while the planner still refuses to walk into a cone. */
function threatAdd(arr, id) {
  var a = arr[id];
  if (a <= 1) return 60;
  if (a === 2) return 25;
  if (a === 3) return 9;
  if (a === 4) return 3;
  return 0;
}

function aStar(m, o, tick, arr, deadline, goalIds, relaxed, lifeBudget) {
  var W = m.W, N = m.N;
  var start = (o.player.y | 0) * W + (o.player.x | 0);
  if (start < 0 || start >= N || m.solid[start]) return null;
  var goalSet = new Uint8Array(N);
  for (var gi = 0; gi < goalIds.length; gi++) {
    if (goalIds[gi] >= 0 && goalIds[gi] < N) goalSet[goalIds[gi]] = 1;
  }
  if (goalSet[start]) return { action: 'wait', ok: true };

  var field = distField(m, goalIds, tick);
  var M = 2 * N;
  var bestG = new Float64Array(M).fill(INF);
  var stepOf = new Int32Array(M).fill(-1);   /* first step, parent-independent */
  var closed = new Uint8Array(M);
  var heap = new Int32Array(M + 8);
  var keys = new Float64Array(M + 8);
  var hn = 0;

  function index(id, phase) {
    return id * 2 + phase;
  }

  var sIdx = index(start, phaseAt(m, start, tick));
  bestG[sIdx] = 0;
  stepOf[sIdx] = -1;
  hn = hpush(heap, keys, hn, sIdx, 0);

  var cur, cid, cx, cy, g, k, nid, add, nb, ng, nx, ny, waitAdd, first;

  while (hn > 0) {
    cur = heap[0];
    hn = hpop(heap, keys, hn);
    if (closed[cur]) continue;
    closed[cur] = 1;
    cid = cur >> 1;
    if (goalSet[cid]) {
      var st0 = stepOf[cur];
      if (st0 < 0) return { action: 'wait', ok: true };
      var a0 = actionBetween(start, st0, m);
      if (a0 === 'wait' || !enterable(m, st0, tick)) return { action: 'wait', ok: false };
      return { action: a0, ok: true };
    }

    cx = cid % W;
    cy = (cid - cx) / W;
    g = bestG[cur];
    first = stepOf[cur];

    /* Waiting costs a move but is the cheapest way to burn a hunter's tempo
       when it is not standing on us. */
    waitAdd = 1;
    if (m.gateRef[cid] >= 0) waitAdd = gateClosedAt(m.gates[m.gateRef[cid]], tick + 1) ? 4 : 1;
    if (m.trapRef[cid] >= 0 && trapActiveAt(m, cid, tick)) waitAdd += relaxed ? 6 : 60;
    nb = index(cid, phaseAt(m, cid, tick + 1));
    if (!closed[nb]) {
      ng = g + waitAdd;
      if (ng < bestG[nb]) {
        bestG[nb] = ng;
        stepOf[nb] = first;
        hn = hpush(heap, keys, hn, nb, ng + hval(field, cid));
      }
    }

    for (k = 0; k < 4; k++) {
      nx = cx + DIRS[k].dx;
      ny = cy + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) continue;
      nid = ny * W + nx;
      if (m.solid[nid]) continue;
      if (!enterable(m, nid, tick)) continue;
      if ((m.gateRef[cid] >= 0 || m.gateRef[nid] >= 0) &&
          !gateTrusted(m, cid, nid, arr, tick)) continue;
      add = moveAdd(m, nid, tick) + threatAdd(arr, nid) * (relaxed ? 0.25 : 1);
      nb = index(nid, phaseAt(m, nid, tick + 1));
      if (closed[nb]) continue;
      ng = g + add;
      if (ng >= bestG[nb]) continue;
      bestG[nb] = ng;
      stepOf[nb] = (first < 0) ? nid : first;
      hn = hpush(heap, keys, hn, nb, ng + hval(field, nid));
    }
    void lifeBudget;
    void deadline;
  }
  return null;
}

function hval(field, id) {
  var e = distEta(field, id);
  return e < 0 ? 0 : e;
}

function finish(m, start, goalNode, parent, tick) {
  var node = goalNode;
  var guard = 0;
  if ((node >> 2) === start) return { action: 'wait', ok: true };
  while (guard++ < 4000) {
    var par = parent[node];
    if (par === -1) break;
    if ((par >> 2) === start) return step(m, start, node >> 2, tick);
    node = par;
  }
  return step(m, start, goalNode >> 2, tick);
}

function step(m, start, target, tick) {
  if (target === start) return { action: 'wait', ok: true };
  var a = actionBetween(start, target, m);
  if (a === 'wait') return { action: 'wait', ok: false };
  if (!enterable(m, target, tick)) return { action: 'wait', ok: false };
  return { action: a, ok: true };
}

function actionBetween(from, to, m) {
  var W = m.W;
  var fx = from % W, fy = (from - fx) / W;
  var tx = to % W, ty = (to - tx) / W;
  if (Math.abs(tx - fx) + Math.abs(ty - fy) !== 1) return 'wait';
  var dx = tx - fx, dy = ty - fy;
  for (var i = 0; i < 4; i++) {
    if (DIRS[i].dx === dx && DIRS[i].dy === dy) return DIRS[i].action;
  }
  return 'wait';
}

function hpush(heap, keys, n, idx, key) {
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

function hpop(heap, keys, n) {
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
/* First steps, deadline, safe detour                                 */
/* ------------------------------------------------------------------ */

function firstSteps(m, o, tick) {
  var px = o.player.x | 0, py = o.player.y | 0;
  var out = [];
  for (var k = 0; k < 4; k++) {
    var nx = px + DIRS[k].dx, ny = py + DIRS[k].dy;
    if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
    var n = ny * m.W + nx;
    if (!enterable(m, n, tick)) continue;
    out.push({ id: n, action: DIRS[k].action });
  }
  return out;
}

/* Pick the first step that minimises the plain number of moves to the goal. */
function plainStep(m, o, tick, goalIds, field, arr) {
  var cands = firstSteps(m, o, tick);
  if (!cands.length) return null;
  var best = INF, act = 'wait', ok = false;
  for (var i = 0; i < cands.length; i++) {
    var e = distEta(field, cands[i].id);
    var cost = (e < 0 ? 90000 : e * 100) + dangerScore(arr, cands[i].id);
    if (cost < best) { best = cost; act = cands[i].action; ok = e >= 0; }
  }
  return { action: act, ok: ok };
}

/* Legality guard for the two steps a decision may end up producing: if the
   cell is not enterable now a `wait` moves us to the right cell for free, and
   an ordinary `wait` is then converted into the detour step, which is what the
   stuck-in-place symptom (the hunter sits on our cell forever) demands. */
function rescue(m, o, tick, safeAt, action, expected, arr) {
  var px = o.player.x | 0, py = o.player.y | 0;
  var start = py * m.W + px;
  var a = stepOutFree(m, start, action, tick);
  if (a !== action) {
    /* our position was not the one we assumed: recompute the step from here */
    return a === 'wait' ? detour(m, o, tick, safeAt) : a;
  }
  var cur = a === 'wait' ? start : nextOf(m, start, a);
  if (cur !== expected) return a;
  if (a !== 'wait' && !hardBlocked(m, cur, tick)) return a;
  var det = detour(m, o, tick, safeAt);
  void arr;
  return det === 'wait' ? a : det;
}

function nextOf(m, start, action) {
  var W = m.W;
  var fx = start % W, fy = (start - fx) / W;
  for (var i = 0; i < 4; i++) {
    if (DIRS[i].action === action) return (fy + DIRS[i].dy) * W + fx + DIRS[i].dx;
  }
  return start;
}

function hardBlocked(m, id, tick) {
  var gi = m.gateRef[id];
  if (gi >= 0 && gateClosedAt(m.gates[gi], tick)) return true;
  return m.trapRef[id] >= 0 && trapActiveAt(m, id, tick);
}

/* A move is legal only if it changes our cell into an enterable neighbour. */
function stepOutFree(m, start, action, tick) {
  if (action === 'wait') return 'wait';
  var nid = nextOf(m, start, action);
  if (nid === start) return 'wait';
  if (!enterable(m, nid, tick)) return 'wait';
  if (!orthogonal(start, nid, m.W)) return 'wait';
  return action;
}

function orthogonal(a, b, W) {
  var ax = a % W, ay = (a - ax) / W;
  var bx = b % W, by = (b - bx) / W;
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

function detour(m, o, tick, safeAt) {
  var det = detourStep(m, o, tick, safeAt);
  if (det && det.ok) return det.action;
  return 'wait';
}
function detourStep(m, o, tick, safeAt) {
  var W = m.W, N = m.N;
  var px = o.player.x | 0, py = o.player.y | 0;
  var start = py * W + px;
  var stepOf = new Int32Array(N).fill(-1);
  var q = new Int32Array(N);
  var qh = 0, qt = 0;
  q[qt++] = start;
  var bestId = -1, bestKey = INF;
  var limit = Math.min(N, 4000);
  while (qh < qt && qh < limit) {
    var id = q[qh++];
    var s = safeAt[id];
    if (id !== start && s >= 0 && s * 10000 < bestKey) {
      bestKey = s * 10000;
      bestId = id;
    }
    var x = id % W, y = (id - x) / W;
    for (var k = 0; k < 4; k++) {
      var nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= m.H) continue;
      var n = ny * W + nx;
      if (stepOf[n] !== -1 || n === start || m.solid[n]) continue;
      stepOf[n] = (id === start) ? n : stepOf[id];
      q[qt++] = n;
    }
  }
  if (bestId < 0) return null;
  var first = stepOf[bestId];
  if (first < 0) return null;
  var a = actionBetween(start, first, m);
  if (a === 'wait' || !enterable(m, first, tick)) return null;
  return { action: a, ok: true };
}

/* ------------------------------------------------------------------ */
/* Memory                                                             */
/* ------------------------------------------------------------------ */

function readMemory(mem) {
  var st = { goal: 'k', hist: [], fresh: false };
  if (!mem || typeof mem !== 'object' || Array.isArray(mem) || mem.v !== 1) return st;
  st.fresh = true;
  if (mem.goal === 'e' || mem.goal === 'k') st.goal = mem.goal;
  if (typeof mem.h === 'string' && mem.h.length <= 120) {
    var parts = mem.h.split('|');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].split(',');
      if (p.length !== 2) continue;
      var x = +p[0], y = +p[1];
      if (isFinite(x) && isFinite(y)) st.hist.push((x | 0) + ',' + (y | 0));
    }
    if (st.hist.length > 10) st.hist = st.hist.slice(st.hist.length - 10);
  }
  return st;
}

/* The trail holds the visited cells, ending with the cell we stand on. */
function writeMemory(st, o) {
  var h = st.hist.slice();
  var cur = (o.player.x | 0) + ',' + (o.player.y | 0);
  if (h.length === 0) h.push(cur);
  else if (h[h.length - 1] !== cur) h.push(cur);
  if (h.length > 10) h = h.slice(h.length - 10);
  st.hist = h;
  return { v: 1, goal: st.goal, h: h.join('|') };
}

/* ------------------------------------------------------------------ */
/* decide()                                                           */
/* ------------------------------------------------------------------ */

function decide(observation) {
  var o = observation;
  if (!o || o.role !== 'runner' || !o.player || !o.grid || !o.exit) {
    return { action: 'wait', memory: null };
  }
  var m = buildModel(o);
  var tick = m.t0;
  var W = m.W, N = m.N;

  var px = o.player.x | 0, py = o.player.y | 0;
  if (px < 0 || py < 0 || px >= W || py >= o.height || m.solid[py * W + px]) {
    return { action: 'wait', memory: null };
  }
  var pId = py * W + px;

  var st = readMemory(o.memory);
  var hasKey = !!o.player.hasKey;
  st.goal = (!hasKey && o.key) ? 'k' : 'e';

  /* The trail records the cells actually visited, ending with the cell we
     stand on now.  Only ever append: overwriting the tail (or clearing on a
     mismatch) destroys the short history the cycle check below needs. */
  var cur = px + ',' + py;
  if (st.hist.length === 0 || st.hist[st.hist.length - 1] !== cur) st.hist.push(cur);
  if (st.hist.length > 10) st.hist = st.hist.slice(st.hist.length - 10);

  var keyId = o.key ? ((o.key.y | 0) * W + (o.key.x | 0)) : -1;
  var exitId = (o.exit.y | 0) * W + (o.exit.x | 0);
  var goalIds = (!hasKey && keyId >= 0) ? [keyId] : [exitId];

  /* ---- hunter pressure ------------------------------------------- */
  var hunters = o.hunters || [];
  var arr = hunterArrivals(m, hunters, tick);
  var budget = Math.max(1, (o.maxTicks | 0) - tick);

  /* ---- deadline -------------------------------------------------- */
  var field = distField(m, goalIds, tick);
  var eta = distEta(field, pId);
  var estCost = eta < 0 ? INF : eta;
  if (!hasKey && keyId >= 0) {
    var f2 = distField(m, [exitId], tick + Math.max(0, estCost));
    var e2 = distEta(f2, keyId);
    if (e2 < 0) estCost = INF;
    else estCost += e2;
  }

  var urgent = estCost >= INF ? budget < 60 : estCost * 2 + 6 >= budget;

  var choice = null;

  /* Already standing on the exit with the key: the round ends on this very
     tick, so any move here only burns time. */
  if (hasKey && exitId === pId) {
    return { action: 'wait', memory: writeMemory(st, o) };
  }

  if (urgent) {
    /* the clock is the real enemy now: ignore hunters, take the short path */
    choice = plainStep(m, o, tick, goalIds, field, arr);
    if (!choice || !choice.ok) choice = aStar(m, o, tick, arr, budget, goalIds, true);
  }

  if (!choice || !choice.ok) {
    choice = aStar(m, o, tick, arr, budget, goalIds, false);
  }
  if (!choice || !choice.ok) {
    var safeAt0 = safeField(m, hunters, arr, tick, tick + budget);
    var det0 = detourStep(m, o, tick, safeAt0);
    if (det0 && det0.ok) choice = det0;
  }
  if (!choice || !choice.ok) {
    choice = plainStep(m, o, tick, goalIds, field, arr);
  }
  if (!choice) choice = { action: 'wait', ok: false };

  var act = legalStep(m, px, py, choice.action, tick);

  /* Anti-oscillation: the trail now ends with the cells we actually visited,
     so walking {A,B,A} means the controller is repeating its own last move.
     Cost: two string entries, benefit: it cannot ping-pong in front of a
     hunter forever.  Deliberately not a signal to "trust the memory", the
     grid alone cannot detect this loop. */
  if (oscillating(st.hist, cur, tick) && act !== 'wait') {
    var esc = freshStep(m, o, tick, arr, goalIds, st.hist);
    if (esc && esc.ok) act = esc.action;
  }

  if (act === 'wait') {
    /* Stuck?  Nothing legal in the planned direction -- take any direction
       instead of losing another tick to the hunter sitting on our cell. */
    var safeAt = safeField(m, hunters, arr, tick, tick + budget);
    var anywhere = detourStep(m, o, tick, safeAt);
    if (anywhere && anywhere.ok) act = anywhere.action;
  }

  return { action: act, memory: writeMemory(st, o) };
}

/* True when the recent trail already walks the pair we are about to repeat:
   {..., A, B, A} with us standing on A means the next step to B closes a
   two-cell loop, and the controller is recomputing the same decision forever. */
function oscillating(hist, curNow, tick) {
  if (!hist || hist.length < 3) return false;
  if (tick < 8) return false;
  var n = hist.length;
  var a = hist[n - 3], b = hist[n - 2], d = hist[n - 1];
  if (d !== curNow) return false;
  return a === curNow && b !== curNow;
}

/* Cheapest legal step that does not close the loop we are in. */
function freshStep(m, o, tick, arr, goalIds, hist) {
  var W = m.W;
  var cands = firstSteps(m, o, tick);
  var best = null, bestCost = INF;
  var back = '';
  var i, id, key;
  var last = hist.length ? hist[hist.length - 1] : '';
  for (i = hist.length - 2; i >= 0; i--) {
    if (hist[i] === last) { back = hist[i + 1]; break; }
  }
  var field = null;
  for (i = 0; i < cands.length; i++) {
    id = cands[i].id;
    if (!enterable(m, id, tick)) continue;
    key = (id % W) + ',' + ((id - (id % W)) / W);
    if (back && key === back) continue;          /* that repeats the loop */
    if (key === last) continue;
    if (!field) field = distField(m, goalIds, tick);
    var e = distEta(field, id);
    var cost = (e < 0 ? 400 : e) + threatAdd(arr, id);
    if (cost < bestCost) { bestCost = cost; best = { action: cands[i].action, ok: true }; }
  }
  return best;
}

function legalStep(m, px, py, act, tick) {
  for (var d = 0; d < 4; d++) {
    if (DIRS[d].action !== act) continue;
    var tx = px + DIRS[d].dx, ty = py + DIRS[d].dy;
    if (tx < 0 || ty < 0 || tx >= m.W || ty >= m.H) return 'wait';
    if (!enterable(m, ty * m.W + tx, tick)) return 'wait';
    return act;
  }
  return 'wait';
}
