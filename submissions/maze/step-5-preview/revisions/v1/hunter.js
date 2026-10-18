// hunter.js
var CACHE = null;

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
  if (o.gates) {
    for (var i = 0; i < o.gates.length; i++) {
      var g = o.gates[i];
      var gi = idxOf(o, g.x, g.y);
      if (gi >= 0 && gi < n && passable[gi]) gateAt[gi] = g;
    }
  }

  CACHE = {
    key: key,
    W: w,
    H: h,
    cellCount: n,
    passable: passable,
    gateAt: gateAt,
    distCache: {}
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

function legalMoves(o, cache, pos, includeWait) {
  var res = [];
  var curIdx = idxOf(o, pos.x, pos.y);

  if (includeWait) {
    res.push({ action: 'wait', x: pos.x, y: pos.y, idx: curIdx });
  }

  for (var i = 0; i < 4; i++) {
    var nx = pos.x + DIRS[i][1];
    var ny = pos.y + DIRS[i][2];

    if (nx < 0 || ny < 0 || nx >= o.width || ny >= o.height) continue;

    var idx = ny * o.width + nx;
    if (!cache.passable[idx]) continue;

    var gate = cache.gateAt[idx];
    if (gate && isGateClosedAt(gate, o.tick)) continue;

    res.push({ action: DIRS[i][0], x: nx, y: ny, idx: idx });
  }

  return res;
}

function chooseHunterActions(o) {
  var cache = ensureCache(o);

  if (!o.hunters || o.hunters.length === 0) return [];

  var playerIdx = idxOf(o, o.player.x, o.player.y);
  var playerDests = legalMoves(o, cache, o.player, true);
  if (playerDests.length === 0) {
    playerDests = [{ action: 'wait', x: o.player.x, y: o.player.y, idx: playerIdx }];
  }

  var pcount = playerDests.length;
  var pdist = [];
  for (var i = 0; i < pcount; i++) {
    pdist.push(bfsFrom(cache, playerDests[i].idx));
  }

  var curDist = bfsFrom(cache, playerIdx);

  var options = [];
  for (var h = 0; h < o.hunters.length; h++) {
    options.push(legalMoves(o, cache, o.hunters[h], true));
  }

  var nh = options.length;
  var combo = new Array(nh);
  var best = null;
  var INF = 1000000;

  function evaluate() {
    var maxDist = 0;
    var sumDist = 0;
    var caught = 0;

    for (var pi = 0; pi < pcount; pi++) {
      var pd = pdist[pi];
      var md = INF;

      for (var hi = 0; hi < nh; hi++) {
        var d = pd[combo[hi].idx];
        if (d >= 0 && d < md) md = d;
      }

      if (md === INF) md = 9999;
      if (md === 0) caught++;
      if (md > maxDist) maxDist = md;
      sumDist += md;
    }

    var allCaught = (caught === pcount) ? 1 : 0;

    var chase = 0;
    for (var hj = 0; hj < nh; hj++) {
      var dc = curDist[combo[hj].idx];
      chase += (dc >= 0) ? dc : 9999;
    }

    var score =
      (1 - allCaught) * 1e12 +
      maxDist * 1e9 +
      sumDist * 1e6 +
      caught * 1e3 +
      chase;

    if (best === null || score < best.score) {
      best = { score: score, combo: combo.slice() };
    }
  }

  function rec(idx) {
    if (idx === nh) {
      evaluate();
      return;
    }

    var opts = options[idx];
    for (var k = 0; k < opts.length; k++) {
      combo[idx] = opts[k];
      rec(idx + 1);
    }
  }

  rec(0);

  if (!best) {
    var waitActions = [];
    for (var w2 = 0; w2 < o.hunters.length; w2++) {
      waitActions.push({ id: o.hunters[w2].id, action: 'wait' });
    }
    return waitActions;
  }

  var actions = [];
  for (var a = 0; a < o.hunters.length; a++) {
    actions.push({ id: o.hunters[a].id, action: best.combo[a].action });
  }
  return actions;
}

function decide(observation) {
  try {
    if (!observation || !observation.hunters || !observation.player) {
      return { actions: [], memory: null };
    }

    var actions = chooseHunterActions(observation);
    return { actions: actions, memory: null };
  } catch (e) {
    var hs = (observation && observation.hunters) ? observation.hunters : [];
    var safe = [];
    for (var i = 0; i < hs.length; i++) {
      safe.push({ id: hs[i] ? hs[i].id : i, action: 'wait' });
    }
    return { actions: safe, memory: null };
  }
}