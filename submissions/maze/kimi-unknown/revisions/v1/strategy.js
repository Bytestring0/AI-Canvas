/* 迷宫竞速 runner 策略：时间感知 A* + 保守追逐风险回避。 */
var RUNNER_MAP_CACHE = Object.create(null);
var RUN_DIRS = [
  { a: 'right', x: 1, y: 0 },
  { a: 'down', x: 0, y: 1 },
  { a: 'left', x: -1, y: 0 },
  { a: 'up', x: 0, y: -1 }
];

function rIndex(x, y, w) { return y * w + x; }
function rIn(x, y, o) { return x >= 0 && y >= 0 && x < o.width && y < o.height; }

function rBfs(map, src) {
  var n = map.n, dist = new Int16Array(n);
  dist.fill(-1);
  if (src < 0 || src >= n || !map.pass[src]) return dist;
  var q = new Int32Array(n), head = 0, tail = 0;
  q[tail++] = src; dist[src] = 0;
  while (head < tail) {
    var v = q[head++], x = v % map.w, y = (v / map.w) | 0, nd = dist[v] + 1;
    var order = [1, 0, -1, 0, 0, 1, 0, -1];
    for (var k = 0; k < 4; k++) {
      var nx = x + order[k * 2], ny = y + order[k * 2 + 1];
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      var u = ny * map.w + nx;
      if (!map.pass[u] || dist[u] !== -1) continue;
      dist[u] = nd; q[tail++] = u;
    }
  }
  return dist;
}

function rMakeMap(o) {
  var n = o.width * o.height;
  var pass = new Uint8Array(n), gateAt = new Int16Array(n), trapAt = new Int16Array(n);
  gateAt.fill(-1); trapAt.fill(-1);
  for (var y = 0; y < o.height; y++) {
    var row = o.grid[y] || [];
    for (var x = 0; x < o.width; x++) {
      if (row[x] === 0) pass[rIndex(x, y, o.width)] = 1;
    }
  }
  for (var gi = 0; gi < o.gates.length; gi++) {
    gateAt[rIndex(o.gates[gi].x, o.gates[gi].y, o.width)] = gi;
  }
  for (var ti = 0; ti < o.traps.length; ti++) {
    trapAt[rIndex(o.traps[ti].x, o.traps[ti].y, o.width)] = ti;
  }

  var keyIdx = o.key ? rIndex(o.key.x, o.key.y, o.width) : -1;
  var exitIdx = rIndex(o.exit.x, o.exit.y, o.width);
  var map = {
    w: o.width, h: o.height, n: n, pass: pass, gateAt: gateAt, trapAt: trapAt,
    gates: o.gates, traps: o.traps, keyIdx: keyIdx, exitIdx: exitIdx,
    distKey: null, distExit: null, coinIdx: [], coinToKey: [], coinToExit: [],
    totalCoins: o.coins.length
  };
  if (keyIdx >= 0) map.distKey = rBfs(map, keyIdx);
  map.distExit = rBfs(map, exitIdx);
  for (var ci = 0; ci < o.coins.length; ci++) {
    var pi = rIndex(o.coins[ci].x, o.coins[ci].y, o.width);
    map.coinIdx.push(pi);
    map.coinToKey.push(keyIdx >= 0 ? rBfs(map, pi) : null);
    map.coinToExit.push(rBfs(map, pi));
  }
  return map;
}

function rGetMap(o) {
  var key = o.seed + '|' + o.width + 'x' + o.height;
  if (!RUNNER_MAP_CACHE[key]) RUNNER_MAP_CACHE[key] = rMakeMap(o);
  return RUNNER_MAP_CACHE[key];
}

function rGateClosed(map, i, tick) {
  var k = map.gateAt[i];
  if (k < 0) return false;
  var g = map.gates[k];
  return ((tick + g.phase) % g.period) < g.on;
}

function rTrapActive(map, i, tick) {
  var k = map.trapAt[i];
  if (k < 0) return false;
  var tr = map.traps[k];
  return ((tick + tr.phase) % tr.period) < tr.on;
}

function rImmune(o, tick) { return tick < o.player.invulnerableUntil; }

function rHunterFields(o, map) {
  var fields = [], minDist = new Int16Array(map.n), i, h, d;
  minDist.fill(32767);
  for (h = 0; h < o.hunters.length; h++) {
    var f = rBfs(map, rIndex(o.hunters[h].x, o.hunters[h].y, map.w));
    fields.push(f);
    for (i = 0; i < map.n; i++) {
      d = f[i];
      if (d >= 0 && d < minDist[i]) minDist[i] = d;
    }
  }
  return { fields: fields, min: minDist };
}

function rHunterMovesBetween(start, arrival, every) {
  if (arrival <= start) return 0;
  var rem = (every - ((start + 1) % every)) % every;
  var first = start + rem;
  if (first >= arrival) return 0;
  return ((arrival - 1 - first) / every | 0) + 1;
}

function rImmediateHunterThreat(o, map, dest) {
  if (rImmune(o, o.tick)) return false;
  var movesNow = ((o.tick + 1) % o.hunterEvery) === 0;
  for (var h = 0; h < o.hunters.length; h++) {
    var hx = o.hunters[h].x, hy = o.hunters[h].y;
    if (rIndex(hx, hy, map.w) === dest) return true;
    if (!movesNow) continue;
    for (var d = 0; d < 4; d++) {
      var nx = hx + RUN_DIRS[d].x, ny = hy + RUN_DIRS[d].y;
      if (!rIn(nx, ny, { width: map.w, height: map.h })) continue;
      var ni = rIndex(nx, ny, map.w);
      if (ni !== dest || !map.pass[ni] || rGateClosed(map, ni, o.tick)) continue;
      return true;
    }
  }
  return false;
}

function rRiskValue(o, hf, dest, departure) {
  if (rImmune(o, departure)) return -1000;
  var arrival = departure + 1;
  var moves = rHunterMovesBetween(o.tick, arrival, o.hunterEvery);
  var best = -1000;
  for (var h = 0; h < hf.fields.length; h++) {
    var d = hf.fields[h][dest];
    if (d < 0) continue;
    var surplus = moves - d;
    if (surplus > best) best = surplus;
  }
  return best;
}

function rHunterBlocked(o, map, hf, dest, departure, relax) {
  if (relax >= 4 || rImmune(o, departure)) return false;
  var arrival = departure + 1;
  if (arrival === o.tick + 1 && rImmediateHunterThreat(o, map, dest)) return true;
  if (relax >= 3) return false;
  var moves = rHunterMovesBetween(o.tick, arrival, o.hunterEvery);
  var budget = moves - relax;
  for (var h = 0; h < hf.fields.length; h++) {
    var d = hf.fields[h][dest];
    if (d >= 0 && d <= budget) return true;
  }
  return false;
}

function rHeapPush(heap, s) {
  heap.push(s);
  var i = heap.length - 1;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (rStateLess(heap[p], heap[i])) break;
    var t = heap[p]; heap[p] = heap[i]; heap[i] = t;
    i = p;
  }
}

function rHeapPop(heap) {
  var top = heap[0], last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    var i = 0;
    for (;;) {
      var l = i * 2 + 1, r = l + 1, m = i;
      if (l < heap.length && rStateLess(heap[l], heap[m])) m = l;
      if (r < heap.length && rStateLess(heap[r], heap[m])) m = r;
      if (m === i) break;
      var t = heap[m]; heap[m] = heap[i]; heap[i] = t;
      i = m;
    }
  }
  return top;
}

function rStateLess(a, b) {
  if (a.pri !== b.pri) return a.pri < b.pri;
  if (a.g !== b.g) return a.g < b.g;
  if (a.risk !== b.risk) return a.risk < b.risk;
  return a.serial < b.serial;
}

function rTryRecord(records, st) {
  var list = records[st.pos], i;
  for (i = list.length - 1; i >= 0; i--) {
    var old = list[i];
    if (old.g <= st.g && old.risk <= st.risk) return false;
    if (old.g >= st.g && old.risk >= st.risk) list.splice(i, 1);
  }
  if (list.length >= 4) {
    var worst = 0;
    for (i = 1; i < list.length; i++) {
      var a = list[i], b = list[worst];
      if (a.g > b.g || (a.g === b.g && a.risk > b.risk)) worst = i;
    }
    list.splice(worst, 1);
  }
  list.push(st);
  return true;
}

function rPlanPath(o, map, hf, start, target, distTarget, relax, extra) {
  if (start === target) return 'wait';
  if (distTarget[start] < 0) return null;
  var base = distTarget[start];
  var cap = Math.min(o.maxTicks - o.tick, base + extra);
  if (cap < 1) return null;

  var records = new Array(map.n), i;
  for (i = 0; i < map.n; i++) records[i] = [];
  var heap = [], serial = 0;
  var startState = {
    pos: start, g: 0, risk: 0, pri: distTarget[start],
    parent: null, action: 'wait', serial: serial++
  };
  rTryRecord(records, startState);
  rHeapPush(heap, startState);
  var expanded = 0, maxExpanded = 16000;

  while (heap.length && expanded < maxExpanded) {
    var st = rHeapPop(heap);
    if (st.pos === target) {
      while (st.parent) {
        if (!st.parent.parent) return st.action;
        st = st.parent;
      }
      return st.action || 'wait';
    }
    expanded++;
    if (st.g >= cap) continue;
    var sx = st.pos % map.w, sy = (st.pos / map.w) | 0;
    var departure = o.tick + st.g;
    for (var d = -1; d < 4; d++) {
      var action = d < 0 ? 'wait' : RUN_DIRS[d].a;
      var nx = sx, ny = sy;
      if (d >= 0) {
        nx += RUN_DIRS[d].x;
        ny += RUN_DIRS[d].y;
      }
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      var np = ny * map.w + nx;
      if (!map.pass[np]) continue;
      if (np !== st.pos && rGateClosed(map, np, departure)) continue;
      if (rTrapActive(map, np, departure) && !rImmune(o, departure)) continue;
      if (rHunterBlocked(o, map, hf, np, departure, relax)) continue;
      var ng = st.g + 1;
      if (ng > cap) continue;
      var risk = rRiskValue(o, hf, np, departure);
      var h = distTarget[np];
      if (h < 0) continue;
      var pri = ng + h + Math.max(0, risk + 1) * 6;
      var ns = {
        pos: np, g: ng, risk: risk, pri: pri,
        parent: st, action: action, serial: serial++
      };
      if (!rTryRecord(records, ns)) continue;
      rHeapPush(heap, ns);
    }
  }
  return null;
}

function rChooseTarget(o, map, curDist, hf) {
  var hasKey = o.player.hasKey;
  var primary = hasKey ? map.exitIdx : map.keyIdx;
  if (primary < 0) primary = map.exitIdx;
  if (curDist[primary] < 0) return { idx: primary, extra: 36, optional: false };

  var remaining = Object.create(null);
  for (var i = 0; i < o.coins.length; i++) {
    remaining[o.coins[i].x + ',' + o.coins[i].y] = 1;
  }
  var slack = o.maxTicks - o.tick - curDist[primary];
  var budget = hasKey ? 15 : 25;
  if (slack < 50) budget = Math.min(budget, 4);
  if (slack < 20) budget = Math.min(budget, 2);
  if (slack < 8) budget = 0;

  var best = -1, bestScore = 2147483647;
  for (var c = 0; c < map.coinIdx.length; c++) {
    var p = map.coinIdx[c];
    if (!remaining[(p % map.w) + ',' + ((p / map.w) | 0)]) continue;
    var dc = curDist[p];
    if (dc < 0) continue;
    var via = hasKey ? map.coinToExit[c][map.exitIdx] : map.coinToKey[c][primary];
    if (via < 0) continue;
    var detour = dc + via - curDist[primary];
    if (detour < 1 || detour > budget) continue;
    var danger = hf.min[p];
    var score = detour * 20;
    if (danger >= 0 && danger <= 3) score += 120;
    else if (danger <= 6) score += 45;
    if (hasKey) score += 10;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (best >= 0) return { idx: best, extra: budget + 14, optional: true };
  return { idx: primary, extra: 36, optional: false };
}

function rImmediateOk(o, map, action, allowContact) {
  var sx = o.player.x, sy = o.player.y, nx = sx, ny = sy;
  for (var d = 0; d < 4; d++) {
    if (RUN_DIRS[d].a === action) {
      nx += RUN_DIRS[d].x;
      ny += RUN_DIRS[d].y;
      break;
    }
  }
  if (!rIn(nx, ny, o)) return false;
  var np = rIndex(nx, ny, map.w);
  if (!map.pass[np]) return false;
  if ((nx !== sx || ny !== sy) && rGateClosed(map, np, o.tick)) return false;
  if (rTrapActive(map, np, o.tick) && !rImmune(o, o.tick)) return false;
  if (!allowContact && rImmediateHunterThreat(o, map, np)) return false;
  return true;
}

function rFallback(o, map, targetDist, hf) {
  var options = [{ a: 'wait', x: o.player.x, y: o.player.y }];
  for (var d = 0; d < 4; d++) {
    var nx = o.player.x + RUN_DIRS[d].x;
    var ny = o.player.y + RUN_DIRS[d].y;
    if (rIn(nx, ny, o)) options.push({ a: RUN_DIRS[d].a, x: nx, y: ny });
  }
  var best = null, bestScore = 2147483647;
  for (var i = 0; i < options.length; i++) {
    var p = rIndex(options[i].x, options[i].y, map.w);
    if (!map.pass[p]) continue;
    if ((options[i].x !== o.player.x || options[i].y !== o.player.y) &&
        rGateClosed(map, p, o.tick)) continue;
    if (rTrapActive(map, p, o.tick) && !rImmune(o, o.tick)) continue;
    var score = 0, td = targetDist[p];
    if (td >= 0) score += td * 20;
    else score += 5000;
    if (rImmediateHunterThreat(o, map, p)) score += 2000;
    var hd = hf.min[p];
    if (hd >= 0) score += Math.max(0, 8 - hd) * 12;
    if (options[i].a === 'wait') score += 3;
    score += i;
    if (score < bestScore) {
      bestScore = score;
      best = options[i].a;
    }
  }
  return best || 'wait';
}

function decide(observation) {
  var o = observation;
  var map = rGetMap(o);
  var start = rIndex(o.player.x, o.player.y, map.w);
  var hf = rHunterFields(o, map);
  var curDist = rBfs(map, start);
  var targetInfo = rChooseTarget(o, map, curDist, hf);
  var target = targetInfo.idx;
  var distTarget = target === map.exitIdx ? map.distExit :
    (target === map.keyIdx && map.distKey ? map.distKey : rBfs(map, target));

  var action = null;
  var attempts = [
    [0, targetInfo.extra],
    [1, targetInfo.extra],
    [2, Math.max(44, targetInfo.extra)],
    [3, Math.max(64, targetInfo.extra)],
    [4, Math.max(100, targetInfo.extra)]
  ];
  for (var i = 0; i < attempts.length && action === null; i++) {
    action = rPlanPath(
      o, map, hf, start, target, distTarget,
      attempts[i][0], attempts[i][1]
    );
    if (action !== null) {
      var allowContact = attempts[i][0] === 4 && o.player.hp > 1;
      if (!rImmediateOk(o, map, action, allowContact)) action = null;
    }
  }
  if (action === null) action = rFallback(o, map, distTarget, hf);

  var memory = {
    seed: o.seed,
    tick: o.tick,
    action: action,
    target: (target % map.w) + ',' + ((target / map.w) | 0),
    optional: !!targetInfo.optional,
    coinsSeen: map.totalCoins
  };
  return { action: action, memory: memory };
}