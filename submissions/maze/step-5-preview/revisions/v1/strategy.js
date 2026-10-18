// strategy.js
var CACHE = null;
var DIST_BUF = null, PARENT_BUF = null, ACTION_BUF = null, BUF_CAP = 0;
var HEAP_KEY = [], HEAP_VAL = [], LAST_POP_KEY = 0;
var LAST_ACTION = 'wait';

var ACTION_NAMES = ['up', 'right', 'down', 'left', 'wait'];
var DIRS = [
  ['up', 0, -1],
  ['right', 1, 0],
  ['down', 0, 1],
  ['left', -1, 0]
];

function idxOf(o, x, y) {
  return y * o.width + x;
}

function gridHash(grid, w, h) {
  var hash = 2166136261;
  for (var y = 0; y < h; y++) {
    var row = grid[y];
    for (var x = 0; x < w; x++) {
      hash ^= (row && row[x]) ? 1 : 0;
      hash = (hash * 16777619) >>> 0;
    }
  }
  return hash >>> 0;
}

function isGateClosedAt(gate, tick) {
  if (!gate || !gate.period) return false;
  return ((tick + gate.phase) % gate.period) < gate.on;
}

function isTrapActiveAt(trap, tick) {
  if (!trap || !trap.period) return false;
  return ((tick + trap.phase) % trap.period) < trap.on;
}

function popcount(x) {
  x = x >>> 0;
  var c = 0;
  while (x) {
    x &= (x - 1);
    c++;
  }
  return c;
}

function ensureCache(o) {
  var key = o.seed + '|' + o.width + '|' + o.height + '|' + gridHash(o.grid, o.width, o.height);
  if (CACHE && CACHE.key === key) return CACHE;

  var w = o.width, h = o.height, n = w * h;
  var passable = new Int8Array(n);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      passable[y * w + x] = (o.grid[y][x] === 0) ? 1 : 0;
    }
  }

  var gateAt = new Array(n).fill(null);
  var trapAt = new Array(n).fill(null);

  if (o.gates) {
    for (var i = 0; i < o.gates.length; i++) {
      var g = o.gates[i];
      var gi = idxOf(o, g.x, g.y);
      if (gi >= 0 && gi < n && passable[gi]) gateAt[gi] = g;
    }
  }

  if (o.traps) {
    for (var j = 0; j < o.traps.length; j++) {
      var tr = o.traps[j];
      var ti = idxOf(o, tr.x, tr.y);
      if (ti >= 0 && ti < n && passable[ti]) trapAt[ti] = tr;
    }
  }

  CACHE = {
    key: key,
    W: w,
    H: h,
    cellCount: n,
    passable: passable,
    gateAt: gateAt,
    trapAt: trapAt,
    distCache: {},
    route: null
  };
  return CACHE;
}

function bfsFrom(cache, source) {
  var n = cache.cellCount;
  if (source < 0 || source >= n) {
    return new Int32Array(n).fill(-1);
  }

  var cached = cache.distCache[source];
  if (cached) return cached;

  var w = cache.W, h = cache.H;
  var dist = new Int32Array(n).fill(-1);
  var q = new Int32Array(n);
  var head = 0, tail = 0;

  dist[source] = 0;
  q[tail++] = source;

  while (head < tail) {
    var cur = q[head++];
    var x = cur % w;
    var y = (cur - x) / w;

    for (var i = 0; i < 4; i++) {
      var nx = x + DIRS[i][1];
      var ny = y + DIRS[i][2];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      var ni = ny * w + nx;
      if (cache.passable[ni] && dist[ni] < 0) {
        dist[ni] = dist[cur] + 1;
        q[tail++] = ni;
      }
    }
  }

  cache.distCache[source] = dist;
  return dist;
}

function buildRoute(o, cache) {
  var startIdx = idxOf(o, o.player.x, o.player.y);
  var exitIdx = idxOf(o, o.exit.x, o.exit.y);
  var hasKey = !!o.player.hasKey || !o.key;

  var pts = [];
  if (o.coins) {
    for (var i = 0; i < o.coins.length; i++) {
      pts.push({ type: 'coin', x: o.coins[i].x, y: o.coins[i].y });
    }
  }

  var keyPoint = -1;
  if (!hasKey) {
    if (o.key) {
      keyPoint = pts.length;
      pts.push({ type: 'key', x: o.key.x, y: o.key.y });
    } else {
      hasKey = true;
    }
  }

  var P = pts.length;

  if (P > 20) {
    var safeRoute = [];
    if (!hasKey && o.key) safeRoute.push({ type: 'key', x: o.key.x, y: o.key.y });
    safeRoute.push({ type: 'exit', x: o.exit.x, y: o.exit.y });
    CACHE.route = safeRoute;
    return;
  }

  var L = P + 1;
  var rows = [];
  for (var p = 0; p < P; p++) {
    rows.push(bfsFrom(cache, idxOf(o, pts[p].x, pts[p].y)));
  }
  rows.push(bfsFrom(cache, startIdx));
  var exitRow = bfsFrom(cache, exitIdx);

  var full = 1 << P;
  var stateCount = full * L;
  var INF = 1000000000;

  var dp = new Int32Array(stateCount);
  dp.fill(INF);
  var parentLast = new Int8Array(stateCount);
  parentLast.fill(-1);

  dp[P] = 0;

  for (var mask = 0; mask < full; mask++) {
    var base = mask * L;
    for (var last = 0; last < L; last++) {
      var curCost = dp[base + last];
      if (curCost >= INF) continue;

      var row = rows[last];
      for (var j = 0; j < P; j++) {
        var bit = 1 << j;
        if (mask & bit) continue;
        var d = row[idxOf(o, pts[j].x, pts[j].y)];
        if (d < 0) continue;

        var nm = mask | bit;
        var ns = nm * L + j;
        var nc = curCost + d;
        if (nc < dp[ns]) {
          dp[ns] = nc;
          parentLast[ns] = last;
        }
      }
    }
  }

  var coinMask = 0;
  for (var c = 0; c < P; c++) {
    if (pts[c].type === 'coin') coinMask |= (1 << c);
  }
  var keyMask = keyPoint >= 0 ? (1 << keyPoint) : 0;
  var coinTotal = o.coins ? o.coins.length : 0;
  if (coinTotal <= 0) coinTotal = 1;

  var maxTicks = Math.max(1, o.maxTicks);
  var softLimit = maxTicks * 0.65;
  var bestScore = Infinity;
  var bestFinish = -1;
  var bestState = -1;

  for (var fm = 0; fm < full; fm++) {
    if (keyMask && (fm & keyMask) === 0) continue;
    var fbase = fm * L;

    for (var fl = 0; fl < L; fl++) {
      if (P > 0 && fl === P) continue;
      var travel = dp[fbase + fl];
      if (travel >= INF) continue;

      var srcIdx = (fl === P) ? startIdx : idxOf(o, pts[fl].x, pts[fl].y);
      var toExit = exitRow[srcIdx];
      if (toExit < 0) continue;

      var finish = o.tick + travel + toExit;
      if (finish > o.maxTicks) continue;

      var cc = popcount(fm & coinMask);
      var score = 2000 * finish / maxTicks - 1000 * cc / coinTotal;
      if (finish > softLimit) {
        score += 800 * (finish - softLimit) / maxTicks;
      }

      if (
        score < bestScore - 1e-9 ||
        (Math.abs(score - bestScore) <= 1e-9 && (bestState < 0 || finish < bestFinish))
      ) {
        bestScore = score;
        bestFinish = finish;
        bestState = fbase + fl;
      }
    }
  }

  if (bestState < 0) {
    var fallback = [];
    if (!hasKey && o.key) fallback.push({ type: 'key', x: o.key.x, y: o.key.y });
    fallback.push({ type: 'exit', x: o.exit.x, y: o.exit.y });
    CACHE.route = fallback;
    return;
  }

  var rev = [];
  var st = bestState;
  while (st !== -1) {
    var smask = (st / L) | 0;
    var slast = st - smask * L;
    if (slast !== P) rev.push(pts[slast]);
    if (slast === P) break;

    var prevLast = parentLast[st];
    if (prevLast < 0) break;
    var prevMask = smask ^ (1 << slast);
    st = prevMask * L + prevLast;
  }

  rev.reverse();
  rev.push({ type: 'exit', x: o.exit.x, y: o.exit.y });
  CACHE.route = rev;
}

function currentTarget(o) {
  var route = CACHE ? CACHE.route : null;
  if (route) {
    for (var i = 0; i < route.length; i++) {
      var p = route[i];
      if (p.type === 'coin') {
        if (o.coins) {
          for (var j = 0; j < o.coins.length; j++) {
            if (o.coins[j].x === p.x && o.coins[j].y === p.y) return p;
          }
        }
      } else if (p.type === 'key') {
        if (!o.player.hasKey && o.key && o.key.x === p.x && o.key.y === p.y) return p;
      } else if (p.type === 'exit') {
        if (o.player.hasKey) return p;
      }
    }
  }

  if (o.player.hasKey) return o.exit;
  return o.key || o.exit;
}

function multiSourceHunterDist(o, cache) {
  var n = cache.cellCount, w = cache.W;
  var dist = new Int32Array(n).fill(-1);
  var q = new Int32Array(n);
  var head = 0, tail = 0;

  if (o.hunters) {
    for (var i = 0; i < o.hunters.length; i++) {
      var h = o.hunters[i];
      var idx = idxOf(o, h.x, h.y);
      if (idx >= 0 && idx < n && cache.passable[idx] && dist[idx] < 0) {
        dist[idx] = 0;
        q[tail++] = idx;
      }
    }
  }

  while (head < tail) {
    var cur = q[head++];
    var x = cur % w;
    var y = (cur - x) / w;

    for (var d = 0; d < 4; d++) {
      var nx = x + DIRS[d][1];
      var ny = y + DIRS[d][2];
      if (nx < 0 || ny < 0 || nx >= w || ny >= cache.H) continue;
      var ni = ny * w + nx;
      if (cache.passable[ni] && dist[ni] < 0) {
        dist[ni] = dist[cur] + 1;
        q[tail++] = ni;
      }
    }
  }

  return dist;
}

function hunterPenalty(hdist, idx, tick, hunterEvery) {
  if (!hdist) return 0;
  var hd = hdist[idx];
  if (hd < 0) return 0;

  var p = 0;
  if (hd === 0) p = 1500;
  else if (hd === 1) p = 350;
  else if (hd === 2) p = 120;
  else if (hd === 3) p = 45;
  else if (hd === 4) p = 15;
  else if (hd === 5) p = 5;

  if (hunterEvery > 0 && ((tick + 1) % hunterEvery) === 0 && hd <= 1) {
    p += 2000;
  }
  return p;
}

function heapPush(key, val) {
  var i = HEAP_KEY.length;
  HEAP_KEY.push(key);
  HEAP_VAL.push(val);

  while (i > 0) {
    var parent = (i - 1) >> 1;
    if (HEAP_KEY[parent] <= HEAP_KEY[i]) break;

    var tk = HEAP_KEY[parent], tv = HEAP_VAL[parent];
    HEAP_KEY[parent] = HEAP_KEY[i];
    HEAP_VAL[parent] = HEAP_VAL[i];
    HEAP_KEY[i] = tk;
    HEAP_VAL[i] = tv;
    i = parent;
  }
}

function heapPop() {
  var topK = HEAP_KEY[0];
  var topV = HEAP_VAL[0];
  var lastK = HEAP_KEY.pop();
  var lastV = HEAP_VAL.pop();
  var size = HEAP_KEY.length;

  if (size > 0) {
    HEAP_KEY[0] = lastK;
    HEAP_VAL[0] = lastV;

    var i = 0;
    while (true) {
      var l = 2 * i + 1;
      var r = l + 1;
      var m = i;

      if (l < size && HEAP_KEY[l] < HEAP_KEY[m]) m = l;
      if (r < size && HEAP_KEY[r] < HEAP_KEY[m]) m = r;
      if (m === i) break;

      var tk = HEAP_KEY[m], tv = HEAP_VAL[m];
      HEAP_KEY[m] = HEAP_KEY[i];
      HEAP_VAL[m] = HEAP_VAL[i];
      HEAP_KEY[i] = tk;
      HEAP_VAL[i] = tv;
      i = m;
    }
  }

  LAST_POP_KEY = topK;
  return topV;
}

function planAction(o, cache, target) {
  if (!target) return { action: '', hdist: null, targetIdx: -1 };
  if (o.maxTicks - o.tick <= 0) {
    return { action: 'wait', hdist: multiSourceHunterDist(o, cache), targetIdx: -1 };
  }

  var w = o.width, h = o.height, n = w * h;
  var startIdx = idxOf(o, o.player.x, o.player.y);
  var targetIdx = idxOf(o, target.x, target.y);

  if (targetIdx < 0 || targetIdx >= n) {
    return { action: '', hdist: null, targetIdx: -1 };
  }

  if (targetIdx === startIdx) {
    return { action: 'wait', hdist: multiSourceHunterDist(o, cache), targetIdx: targetIdx };
  }

  var sdist = bfsFrom(cache, targetIdx);
  var sd = sdist[startIdx];
  if (sd < 0) {
    return { action: '', hdist: null, targetIdx: targetIdx };
  }

  var remaining = o.maxTicks - o.tick;
  var horizon = Math.max(sd + 80, sd * 2 + 40);
  if (horizon > remaining) horizon = remaining;
  if (horizon > 600) horizon = 600;
  if (horizon < 1) horizon = 1;

  var times = horizon + 1;
  var cap = times * n;

  if (BUF_CAP < cap) {
    DIST_BUF = new Float32Array(cap);
    PARENT_BUF = new Int32Array(cap);
    ACTION_BUF = new Int8Array(cap);
    BUF_CAP = cap;
  }

  DIST_BUF.fill(Infinity, 0, cap);
  PARENT_BUF.fill(-1, 0, cap);
  ACTION_BUF.fill(-1, 0, cap);

  var hdist = multiSourceHunterDist(o, cache);
  HEAP_KEY.length = 0;
  HEAP_VAL.length = 0;

  var startState = startIdx;
  DIST_BUF[startState] = 0;
  heapPush(sdist[startIdx], startState);

  var goalState = -1;

  while (HEAP_KEY.length > 0) {
    var s = heapPop();
    var lt = (s / n) | 0;
    var cell = s - lt * n;
    var t = o.tick + lt;
    var g = DIST_BUF[s];
    var hs = sdist[cell];
    if (hs < 0) hs = 0;

    if (g + hs > LAST_POP_KEY + 1e-6) continue;
    if (cell === targetIdx) {
      goalState = s;
      break;
    }

    var x = cell % w;
    var y = (cell - x) / w;

    for (var a = 0; a < 5; a++) {
      var nx = x, ny = y;

      if (a < 4) {
        nx = x + DIRS[a][1];
        ny = y + DIRS[a][2];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      }

      var nidx = ny * w + nx;

      if (a < 4) {
        if (!cache.passable[nidx]) continue;
        var gate = cache.gateAt[nidx];
        if (gate && isGateClosedAt(gate, t)) continue;
      }

      var nt = t + 1;
      var nlt = nt - o.tick;
      if (nlt > horizon) continue;

      var extra = 0;
      var trap = cache.trapAt[nidx];
      if (trap && isTrapActiveAt(trap, t)) extra += 600;
      extra += hunterPenalty(hdist, nidx, t, o.hunterEvery);

      var step = (a === 4) ? 1.05 : 1;
      var nc = g + step + extra;
      var ns = nlt * n + nidx;

      if (nc < DIST_BUF[ns]) {
        DIST_BUF[ns] = nc;
        PARENT_BUF[ns] = s;
        ACTION_BUF[ns] = a;
        var nh = sdist[nidx];
        if (nh < 0) nh = 0;
        heapPush(nc + nh, ns);
      }
    }
  }

  if (goalState < 0) {
    return { action: '', hdist: hdist, targetIdx: targetIdx };
  }

  var act = -1;
  var ps = goalState;
  while (ps !== -1 && PARENT_BUF[ps] !== -1) {
    act = ACTION_BUF[ps];
    ps = PARENT_BUF[ps];
  }
  if (act < 0) act = 4;

  return { action: ACTION_NAMES[act], hdist: hdist, targetIdx: targetIdx };
}

function destForAction(o, cache, action) {
  if (action === 'wait') {
    return idxOf(o, o.player.x, o.player.y);
  }

  for (var i = 0; i < 4; i++) {
    if (DIRS[i][0] !== action) continue;

    var nx = o.player.x + DIRS[i][1];
    var ny = o.player.y + DIRS[i][2];
    if (nx < 0 || ny < 0 || nx >= o.width || ny >= o.height) return -1;

    var idx = ny * o.width + nx;
    if (!cache.passable[idx]) return -1;

    var gate = cache.gateAt[idx];
    if (gate && isGateClosedAt(gate, o.tick)) return -1;

    return idx;
  }

  return -1;
}

function candidateScore(o, cache, action, idx, sdist, hdist, planned) {
  var score = 0;

  var d = sdist ? sdist[idx] : -1;
  if (d >= 0) score -= d * 10;
  else score -= 10000;

  if (action === 'wait') score -= 30;

  var trap = cache.trapAt[idx];
  if (trap && isTrapActiveAt(trap, o.tick)) score -= 5000;

  if (hdist) {
    var hd = hdist[idx];
    if (hd >= 0) {
      if (hd === 0) score -= 5000;
      else if (hd === 1) score -= 1200;
      else if (hd === 2) score -= 300;
      else if (hd === 3) score -= 80;
      else if (hd === 4) score -= 20;
      else if (hd === 5) score -= 5;

      if (o.hunterEvery > 0 && ((o.tick + 1) % o.hunterEvery) === 0 && hd <= 1) {
        score -= 4000;
      }
    }
  }

  if (planned && action === planned) score += 25;
  if (LAST_ACTION && action === LAST_ACTION) score += 3;

  return score;
}

function chooseBestCandidate(o, cache, target, hdist, planned) {
  if (!target) return 'wait';

  var targetIdx = idxOf(o, target.x, target.y);
  var sdist = bfsFrom(cache, targetIdx);
  var bestAction = null;
  var bestScore = -Infinity;

  for (var i = 0; i < ACTION_NAMES.length; i++) {
    var action = ACTION_NAMES[i];
    var idx = destForAction(o, cache, action);
    if (idx < 0) continue;

    var sc = candidateScore(o, cache, action, idx, sdist, hdist, planned);
    if (sc > bestScore) {
      bestScore = sc;
      bestAction = action;
    }
  }

  return bestAction || 'wait';
}

function safetyOverride(o, cache, planned, target, hdist) {
  var need = false;

  if (!planned) {
    need = true;
  } else {
    var pidx = destForAction(o, cache, planned);
    if (pidx < 0) {
      need = true;
    } else {
      var pt = cache.trapAt[pidx];
      if (pt && isTrapActiveAt(pt, o.tick)) need = true;

      if (hdist) {
        var hd = hdist[pidx];
        if (hd === 0) need = true;
        if (o.hunterEvery > 0 && ((o.tick + 1) % o.hunterEvery) === 0 && hd <= 1) {
          need = true;
        }
      }
    }
  }

  if (!need) return null;
  return chooseBestCandidate(o, cache, target, hdist, planned);
}

function decide(observation) {
  try {
    if (!observation || !observation.grid || !observation.player) {
      return { action: 'wait', memory: { last: 'wait' } };
    }

    var mem = observation.memory;
    if (mem && typeof mem.last === 'string' && ACTION_NAMES.indexOf(mem.last) >= 0) {
      LAST_ACTION = mem.last;
    }

    var cache = ensureCache(observation);
    if (!cache.route) buildRoute(observation, cache);

    var target = currentTarget(observation);
    var res = planAction(observation, cache, target);
    var action = res && res.action ? res.action : '';

    if (!action) {
      action = chooseBestCandidate(observation, cache, target, res ? res.hdist : null, '') || 'wait';
    } else {
      var over = safetyOverride(observation, cache, action, target, res.hdist);
      if (over) action = over;
    }

    if (ACTION_NAMES.indexOf(action) < 0) action = 'wait';

    LAST_ACTION = action;
    return { action: action, memory: { last: action } };
  } catch (e) {
    return { action: 'wait', memory: { last: 'wait' } };
  }
}