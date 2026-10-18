/* 迷宫竞速 hunter 策略：多路预测、提前拦截与终点封堵。 */
var HUNTER_MAP_CACHE = Object.create(null);
var H_DIRS = [
  { a: 'right', x: 1, y: 0 },
  { a: 'down', x: 0, y: 1 },
  { a: 'left', x: -1, y: 0 },
  { a: 'up', x: 0, y: -1 }
];

function hIndex(x, y, w) { return y * w + x; }
function hIn(x, y, o) { return x >= 0 && y >= 0 && x < o.width && y < o.height; }

function hBfs(map, src) {
  var n = map.n, dist = new Int16Array(n);
  dist.fill(-1);
  if (src < 0 || src >= n || !map.pass[src]) return dist;
  var q = new Int32Array(n), head = 0, tail = 0;
  q[tail++] = src; dist[src] = 0;
  var dx = [1, 0, -1, 0], dy = [0, 1, 0, -1];
  while (head < tail) {
    var v = q[head++], x = v % map.w, y = (v / map.w) | 0, nd = dist[v] + 1;
    for (var k = 0; k < 4; k++) {
      var nx = x + dx[k], ny = y + dy[k];
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      var u = ny * map.w + nx;
      if (!map.pass[u] || dist[u] !== -1) continue;
      dist[u] = nd;
      q[tail++] = u;
    }
  }
  return dist;
}

function hMakeMap(o) {
  var n = o.width * o.height;
  var pass = new Uint8Array(n);
  var gateAt = new Int16Array(n);
  var trapAt = new Int16Array(n);
  gateAt.fill(-1);
  trapAt.fill(-1);
  for (var y = 0; y < o.height; y++) {
    var row = o.grid[y] || [];
    for (var x = 0; x < o.width; x++) {
      if (row[x] === 0) pass[hIndex(x, y, o.width)] = 1;
    }
  }
  for (var i = 0; i < o.gates.length; i++) {
    gateAt[hIndex(o.gates[i].x, o.gates[i].y, o.width)] = i;
  }
  for (var j = 0; j < o.traps.length; j++) {
    trapAt[hIndex(o.traps[j].x, o.traps[j].y, o.width)] = j;
  }
  return {
    w: o.width, h: o.height, n: n, pass: pass,
    gateAt: gateAt, trapAt: trapAt, gates: o.gates, traps: o.traps
  };
}

function hGetMap(o) {
  var key = o.seed + '|' + o.width + 'x' + o.height;
  if (!HUNTER_MAP_CACHE[key]) HUNTER_MAP_CACHE[key] = hMakeMap(o);
  return HUNTER_MAP_CACHE[key];
}

function hGateClosed(map, i, tick) {
  var k = map.gateAt[i];
  if (k < 0) return false;
  var g = map.gates[k];
  return ((tick + g.phase) % g.period) < g.on;
}

function hTrapActive(map, i, tick) {
  var k = map.trapAt[i];
  if (k < 0) return false;
  var tr = map.traps[k];
  return ((tick + tr.phase) % tr.period) < tr.on;
}

function hLegalDest(map, x, y, tick) {
  if (!hIn(x, y, { width: map.w, height: map.h })) return false;
  var p = hIndex(x, y, map.w);
  return !!map.pass[p] && !hGateClosed(map, p, tick);
}

function hPlayerOptions(o, map, distTarget, minHunter) {
  var out = [{ x: o.player.x, y: o.player.y, wait: true }];
  var immune = o.tick < o.player.invulnerableUntil;
  for (var d = 0; d < 4; d++) {
    var nx = o.player.x + H_DIRS[d].x;
    var ny = o.player.y + H_DIRS[d].y;
    if (!hLegalDest(map, nx, ny, o.tick)) continue;
    var p = hIndex(nx, ny, map.w);
    if (hTrapActive(map, p, o.tick) && !immune) continue;
    out.push({ x: nx, y: ny, wait: false });
  }
  for (var i = 1; i < out.length; i++) {
    var a = out[i];
    var p2 = hIndex(a.x, a.y, map.w);
    var dt = distTarget[p2];
    var mh = minHunter[p2];
    a.score = (dt >= 0 ? dt : 60) * 12 - (mh < 32767 ? mh : 60) * 3;
    if (a.wait) a.score += 8;
  }
  out.sort(function (a, b) {
    if (a.score !== b.score) return a.score - b.score;
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return (a.wait ? 1 : 0) - (b.wait ? 1 : 0);
  });
  return out.slice(0, Math.min(3, out.length));
}

function hBuildRoute(o, map, distTarget, minHunter, limit) {
  var cur = hIndex(o.player.x, o.player.y, map.w);
  var route = [cur], seen = Object.create(null);
  seen[cur] = 1;
  for (var step = 0; step < limit; step++) {
    if (cur < 0 || distTarget[cur] === 0) break;
    var cx = cur % map.w, cy = (cur / map.w) | 0;
    var best = -1, bestScore = 2147483647;
    for (var d = 0; d < 4; d++) {
      var nx = cx + H_DIRS[d].x, ny = cy + H_DIRS[d].y;
      if (!hIn(nx, ny, { width: map.w, height: map.h })) continue;
      var np = hIndex(nx, ny, map.w);
      if (!map.pass[np] || seen[np]) continue;
      var dt = distTarget[np];
      if (dt < 0 || dt !== distTarget[cur] - 1) continue;
      var score = -minHunter[np] * 4 + d;
      if (hGateClosed(map, np, o.tick + step)) score += 20;
      if (hTrapActive(map, np, o.tick + step) &&
          o.tick + step >= o.player.invulnerableUntil) score += 12;
      if (score < bestScore) {
        bestScore = score;
        best = np;
      }
    }
    if (best < 0) break;
    cur = best;
    route.push(cur);
    seen[cur] = 1;
  }
  return route;
}

function hCandidateActions(o, map, hunter) {
  var opts = [{ x: hunter.x, y: hunter.y, action: 'wait' }];
  for (var d = 0; d < 4; d++) {
    var nx = hunter.x + H_DIRS[d].x;
    var ny = hunter.y + H_DIRS[d].y;
    if (hLegalDest(map, nx, ny, o.tick)) {
      opts.push({ x: nx, y: ny, action: H_DIRS[d].a });
    }
  }
  return opts;
}

function hMinDistFrom(fields, points) {
  var best = 32767;
  for (var i = 0; i < points.length; i++) {
    var d = fields[points[i]];
    if (d >= 0 && d < best) best = d;
  }
  return best;
}

function hScoreCandidate(o, map, opt, distFromPlayer, distTarget,
                         playerPoints, routePoints, claimed) {
  var p = hIndex(opt.x, opt.y, map.w);
  var cd = hBfs(map, p);
  var dNext = hMinDistFrom(cd, playerPoints);
  var dRoute = hMinDistFrom(cd, routePoints);
  var dPlayer = distFromPlayer[p];
  var dObjective = distTarget[p];
  var manhattan = Math.abs(opt.x - o.player.x) + Math.abs(opt.y - o.player.y);
  if (dNext >= 32767) dNext = 40;
  if (dRoute >= 32767) dRoute = 50;
  if (dPlayer < 0) dPlayer = 60;
  if (dObjective < 0) dObjective = 80;

  var score = 14 * dNext + 7 * dRoute + 3 * dPlayer + 6 * manhattan;
  score += (o.player.hasKey ? 8 : 3) * dObjective;
  if (hTrapActive(map, p, o.tick) && o.tick >= o.player.invulnerableUntil) score += 8;
  if (claimed[p]) score += 4;
  if (opt.action === 'wait') score += 1;
  return score;
}

function decide(observation) {
  var o = observation;
  if (!o.hunters || !o.hunters.length) {
    return { actions: [], memory: o.memory || null };
  }

  var map = hGetMap(o);
  var targetPos = (o.player.hasKey || !o.key) ? o.exit : o.key;
  var target = hIndex(targetPos.x, targetPos.y, map.w);
  var distFromPlayer = hBfs(map, hIndex(o.player.x, o.player.y, map.w));
  var distTarget = hBfs(map, target);

  var minHunter = new Int16Array(map.n);
  minHunter.fill(32767);
  for (var i = 0; i < o.hunters.length; i++) {
    var f = hBfs(map, hIndex(o.hunters[i].x, o.hunters[i].y, map.w));
    for (var p = 0; p < map.n; p++) {
      if (f[p] >= 0 && f[p] < minHunter[p]) minHunter[p] = f[p];
    }
  }

  var playerOptions = hPlayerOptions(o, map, distTarget, minHunter);
  var playerPoints = playerOptions.map(function (q) {
    return hIndex(q.x, q.y, map.w);
  });

  var route = hBuildRoute(o, map, distTarget, minHunter, o.hunterEvery + 8);
  var routePoints = [];
  for (var r = Math.min(o.hunterEvery, route.length - 1); r < route.length; r++) {
    routePoints.push(route[r]);
  }

  var claimed = Object.create(null);
  var actions = [];
  var prev = (o.memory && typeof o.memory === 'object' && !Array.isArray(o.memory))
    ? o.memory : {};

  for (var hi = 0; hi < o.hunters.length; hi++) {
    var hunter = o.hunters[hi];
    var opts = hCandidateActions(o, map, hunter);
    var best = null, bestScore = 2147483647;

    for (var ci = 0; ci < opts.length; ci++) {
      var score = hScoreCandidate(
        o, map, opts[ci], distFromPlayer, distTarget,
        playerPoints, routePoints, claimed
      );
      var last = prev && prev.last ? prev.last[hunter.id] : null;
      if (last && last.x === opts[ci].x && last.y === opts[ci].y && last.a !== 'wait') {
        score += 1;
      }
      if (score < bestScore ||
          (score === bestScore && best && opts[ci].action < best.action)) {
        bestScore = score;
        best = opts[ci];
      }
    }

    if (!best) best = { x: hunter.x, y: hunter.y, action: 'wait' };
    claimed[hIndex(best.x, best.y, map.w)] = hunter.id;
    actions.push({ id: hunter.id, action: best.action });
  }

  var nextLast = {};
  for (var ai = 0; ai < actions.length; ai++) {
    var h2 = null;
    for (var hj = 0; hj < o.hunters.length; hj++) {
      if (o.hunters[hj].id === actions[ai].id) h2 = o.hunters[hj];
    }
    if (h2) {
      nextLast[h2.id] = { x: h2.x, y: h2.y, a: actions[ai].action };
    }
  }

  return {
    actions: actions,
    memory: { seed: o.seed, tick: o.tick, last: nextLast }
  };
}