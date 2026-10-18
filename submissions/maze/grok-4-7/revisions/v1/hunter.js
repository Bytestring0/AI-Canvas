// Hunter strategy for maze-1.
// Called once per hunter-move tick for every hunter in this world.
// Deterministic intercept: cover the player's geodesic exits when close,
// otherwise cut the shortest path to the key (or the exit).

function decide(o) {
  var W = o.width;
  var H = o.height;
  var N = W * H;
  var grid = o.grid;
  var tick = o.tick | 0;
  var E = o.hunterEvery | 0;
  if (E < 1) E = 1;
  var mem = o.memory && typeof o.memory === "object" ? o.memory : null;
  var lastDir = mem && mem.ld && mem.ld.length ? mem.ld : [];

  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];
  var NAME = ["up", "right", "down", "left", "wait"];

  var isGate = new Uint8Array(N);
  var gateP = new Int16Array(N);
  var gatePh = new Int16Array(N);
  var gateOn = new Int16Array(N);
  var i;
  for (i = 0; i < o.gates.length; i++) {
    var g = o.gates[i];
    var gi = (g.y | 0) * W + (g.x | 0);
    if (gi < 0 || gi >= N) continue;
    isGate[gi] = 1;
    gateP[gi] = g.period | 0;
    gatePh[gi] = g.phase | 0;
    gateOn[gi] = g.on | 0;
  }

  function mod(a, p) {
    if (p <= 0) return 0;
    var m = a % p;
    return m < 0 ? m + p : m;
  }
  function canEnter(iCell) {
    if (iCell < 0 || iCell >= N) return false;
    var x = iCell % W;
    var y = (iCell / W) | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    if (grid[y][x] !== 0) return false;
    if (!isGate[iCell]) return true;
    return mod(tick + gatePh[iCell], gateP[iCell]) >= gateOn[iCell];
  }
  function bfsFrom(src) {
    var dist = new Int16Array(N);
    var parent = new Int32Array(N);
    for (var k = 0; k < N; k++) {
      dist[k] = -1;
      parent[k] = -1;
    }
    if (src < 0 || src >= N) return { dist: dist, parent: parent };
    var sx = src % W;
    var sy = (src / W) | 0;
    if (grid[sy][sx] !== 0) return { dist: dist, parent: parent };
    var q = new Int32Array(N);
    var qh = 0;
    var qt = 0;
    dist[src] = 0;
    q[qt++] = src;
    while (qh < qt) {
      var cur = q[qh++];
      var cd = dist[cur];
      var x = cur % W;
      var y = (cur / W) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d];
        var ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (grid[ny][nx] !== 0) continue;
        var ni = ny * W + nx;
        if (dist[ni] !== -1) continue;
        dist[ni] = cd + 1;
        parent[ni] = cur;
        q[qt++] = ni;
      }
    }
    return { dist: dist, parent: parent };
  }

  var px = o.player.x | 0;
  var py = o.player.y | 0;
  var playerI = py * W + px;
  var hasKey = !!o.player.hasKey;
  var goal = !hasKey && o.key ? o.key : o.exit;
  var goalI = (goal.y | 0) * W + (goal.x | 0);
  var exitI = (o.exit.y | 0) * W + (o.exit.x | 0);

  var toGoal = bfsFrom(goalI);
  var distGoal = toGoal.dist;

  function resolvePlayer(action) {
    if (action >= 4) return playerI;
    var ni = (py + DY[action]) * W + (px + DX[action]);
    if (!canEnter(ni)) return playerI;
    return ni;
  }

  var curD = distGoal[playerI];
  if (curD < 0) curD = 30000;
  var ranked = [];
  for (var a = 0; a < 5; a++) {
    var ni = a === 4 ? playerI : resolvePlayer(a);
    var nd = distGoal[ni];
    if (nd < 0) nd = 30000;
    if (nd > curD) continue;
    ranked.push({ i: ni, d: nd, a: a });
  }
  ranked.sort(function (p, q) {
    if (p.d !== q.d) return p.d - q.d;
    if (p.a === 4) return 1;
    if (q.a === 4) return -1;
    return p.a - q.a;
  });
  var uniq = [];
  var seenL = new Uint8Array(N);
  for (i = 0; i < ranked.length; i++) {
    if (seenL[ranked[i].i]) continue;
    seenL[ranked[i].i] = 1;
    uniq.push(ranked[i].i);
  }
  var pred = uniq.length ? uniq[0] : playerI;

  // Shortest path from the player to the objective, gates treated as open.
  var path = [playerI];
  var seenP = new Uint8Array(N);
  seenP[playerI] = 1;
  var cur = playerI;
  var guard = 0;
  while (cur !== goalI && guard++ < N) {
    var bd = distGoal[cur];
    if (bd <= 0) break;
    var x = cur % W;
    var y = (cur / W) | 0;
    var next = -1;
    for (var d = 0; d < 4; d++) {
      var nx = x + DX[d];
      var ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (grid[ny][nx] !== 0) continue;
      var ni = ny * W + nx;
      if (seenP[ni]) continue;
      if (distGoal[ni] === bd - 1) {
        next = ni;
        break;
      }
    }
    if (next < 0) break;
    seenP[next] = 1;
    path.push(next);
    cur = next;
  }

  var hs = [];
  for (i = 0; i < o.hunters.length; i++) {
    var h = o.hunters[i];
    hs.push({ id: h.id | 0, x: h.x | 0, y: h.y | 0, i: (h.y | 0) * W + (h.x | 0) });
  }
  hs.sort(function (p, q) { return p.id - q.id; });

  var trees = new Array(hs.length);
  for (i = 0; i < hs.length; i++) trees[i] = bfsFrom(hs[i].i);

  function slackAt(tree, cell, pi) {
    var d = tree.dist[cell];
    if (d < 0) return -999999;
    var avail = (((pi - 1) / E) | 0) + 1;
    return avail - d;
  }

  function interceptIndex(tree, modeLate) {
    var found = -1;
    var bestSlack = -999999;
    var bestI = path.length > 1 ? path.length - 1 : 0;
    for (var pi = 1; pi < path.length; pi++) {
      var s = slackAt(tree, path[pi], pi);
      if (s === -999999) continue;
      if (s >= 0) {
        if (!modeLate) return pi;
        found = pi;
      }
      if (s > bestSlack) {
        bestSlack = s;
        bestI = pi;
      }
    }
    if (modeLate && found >= 0) return found;
    return bestI;
  }

  var minHunterDist = 999;
  var closeIdx = [];
  for (i = 0; i < hs.length; i++) {
    var dp0 = trees[i].dist[playerI];
    if (dp0 < 0) dp0 = 999;
    if (dp0 < minHunterDist) minHunterDist = dp0;
    if (dp0 <= E + 1) closeIdx.push(i);
  }

  var targetOf = new Array(hs.length);
  var used = new Uint8Array(N);
  var assigned = new Uint8Array(hs.length);

  for (var li = 0; li < uniq.length && closeIdx.length; li++) {
    var cell = uniq[li];
    var pick = -1;
    var pd = 999999;
    for (var ci = 0; ci < closeIdx.length; ci++) {
      var hi = closeIdx[ci];
      if (assigned[hi]) continue;
      var d = trees[hi].dist[cell];
      if (d < 0) continue;
      if (d < pd) {
        pd = d;
        pick = hi;
      }
    }
    if (pick >= 0 && pd <= E + 1) {
      targetOf[pick] = cell;
      assigned[pick] = 1;
      used[cell] = 1;
    }
  }

  for (i = 0; i < hs.length; i++) {
    if (assigned[i]) continue;
    var late = i === hs.length - 1 && hs.length >= 2;
    var idx = interceptIndex(trees[i], late);
    var cell2 = path[idx];
    if (used[cell2] && path.length > 1) {
      var alt = idx + E;
      if (alt >= path.length) alt = path.length - 1;
      if (alt < 1) alt = path.length > 1 ? 1 : 0;
      if (!used[path[alt]]) cell2 = path[alt];
    }
    // A single far hunter still steps onto the predicted cell when already adjacent.
    var dPred = trees[i].dist[pred];
    if (dPred >= 0 && dPred <= 1) cell2 = pred;
    targetOf[i] = cell2;
    used[cell2] = 1;
    assigned[i] = 1;
  }

  // If the objective is the exit, do not camp ON the exit: success is resolved
  // before hunters move and before damage. Hold the approach cell instead.
  for (i = 0; i < hs.length; i++) {
    if (targetOf[i] !== exitI) continue;
    if (path.length >= 2) targetOf[i] = path[path.length - 2];
  }

  function firstStep(hIndex, target) {
    var h = hs[hIndex];
    if (target === h.i) return 4;
    var treeT = bfsFrom(target);
    var bd = treeT.dist[h.i];
    if (bd < 0) return 4;
    var bestD = bd;
    var bestDir = 4;
    var memDir = lastDir.length > h.id && typeof lastDir[h.id] === "number" ? lastDir[h.id] | 0 : -1;
    for (var d = 0; d < 4; d++) {
      var nx = h.x + DX[d];
      var ny = h.y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var ni = ny * W + nx;
      if (!canEnter(ni)) continue;
      var nd = treeT.dist[ni];
      if (nd < 0 || nd > bestD) continue;
      if (nd < bestD) {
        bestD = nd;
        bestDir = d;
      } else if (nd === bestD && bestD < bd) {
        if (d === memDir) bestDir = d;
        else if (bestDir === 4) bestDir = d;
      }
    }
    // Only step if it strictly approaches the target.
    if (bestD < bd) return bestDir;
    return 4;
  }

  var dirById = new Array(hs.length);
  var actions = [];
  var ld = [];
  for (i = 0; i < hs.length; i++) {
    var dir = firstStep(i, targetOf[i]);
    dirById[i] = dir;
    actions.push({ id: hs[i].id, action: NAME[dir] });
    ld[hs[i].id] = dir;
  }

  // Preserve last-dir slots for ids we might have skipped (should be none).
  if (lastDir && lastDir.length) {
    for (i = 0; i < lastDir.length; i++) {
      if (typeof ld[i] !== "number") ld[i] = lastDir[i] | 0;
    }
  }

  actions.sort(function (p, q) { return p.id - q.id; });

  // Fill any missing id defensively (ids are dense from 0, but be exact to the input).
  var have = {};
  for (i = 0; i < actions.length; i++) have[actions[i].id] = 1;
  for (i = 0; i < o.hunters.length; i++) {
    var id = o.hunters[i].id | 0;
    if (!have[id]) actions.push({ id: id, action: "wait" });
  }
  actions.sort(function (p, q) { return p.id - q.id; });

  // Drop accidental duplicates, keeping the planned action.
  var dedup = [];
  var seenId = {};
  for (i = 0; i < actions.length; i++) {
    if (seenId[actions[i].id]) continue;
    seenId[actions[i].id] = 1;
    dedup.push(actions[i]);
  }

  return { actions: dedup, memory: { ld: ld } };
}