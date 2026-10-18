// hunter.js — chaser policy
// Deterministic, synchronous, no external dependencies.
// Predicts the runner's next cell by one-step lookahead over current state
// (closest-to-runner reachable neighbor), then each hunter steps greedily
// toward the interception point using precomputed BFS distance maps.
// hunter.js is called once per hunter tick for ALL hunters, so we compute
// the runner-prediction once and reuse it for every id.

function decide(o) {
  var W = o.width, H = o.height;
  var t0 = o.tick;

  var gateAt = {}, trapAt = {};
  var i, d;
  for (i = 0; i < o.gates.length; i++) {
    var gg = o.gates[i];
    gateAt[gg.x + ',' + gg.y] = gg;
  }
  for (i = 0; i < o.traps.length; i++) {
    var tr = o.traps[i];
    trapAt[tr.x + ',' + tr.y] = tr;
  }
  function gateClosedAt(x, y, t) {
    var gg = gateAt[x + ',' + y];
    return gg ? ((t + gg.phase) % gg.period) < gg.on : false;
  }
  function passable(x, y, t) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    if (o.grid[y][x] !== 0) return false;
    if (gateClosedAt(x, y, t)) return false;
    return true;
  }

  var p = o.player;
  var dirs = [[1, 0, 'right'], [-1, 0, 'left'], [0, 1, 'down'], [0, -1, 'up']];

  // ---------- predict runner next cell ----------
  // The runner most plausibly moves to the neighboring passable cell that
  // reduces its distance to its current objective (exit if hasKey else key),
  // breaking ties deterministically by direction order and distance.
  function predictRunner() {
    var gx, gy;
    if (p.hasKey || (o.key && o.key.x === p.x && o.key.y === p.y)) { gx = o.exit.x; gy = o.exit.y; }
    else if (o.key) { gx = o.key.x; gy = o.key.y; }
    else { gx = o.exit.x; gy = o.exit.y; }

    var dist = bfsFrom(gx, gy, t0 + 1);
    var px = p.x, py = p.y;
    var bestD = dist[px + ',' + py];
    if (bestD === undefined) bestD = 1e9;
    var bestDir = 'wait';
    for (d = 0; d < 4; d++) {
      var nx = px + dirs[d][0], ny = py + dirs[d][1];
      if (!passable(nx, ny, t0 + 1)) continue;
      var nd = dist[nx + ',' + ny];
      if (nd === undefined) continue;
      if (nd < bestD) { bestD = nd; bestDir = dirs[d][2]; }
    }
    var r = { x: px, y: py };
    if (bestDir === 'right') r.x++;
    else if (bestDir === 'left') r.x--;
    else if (bestDir === 'down') r.y++;
    else if (bestDir === 'up') r.y--;
    return r;
  }

  // ---------- BFS distance map from a source at a given tick ----------
  function bfsFrom(sx, sy, t) {
    var dist = {};
    dist[sx + ',' + sy] = 0;
    var q = [[sx, sy]];
    var head = 0;
    while (head < q.length) {
      var c = q[head]; head++;
      var cd = dist[c[0] + ',' + c[1]];
      for (d = 0; d < 4; d++) {
        var nx = c[0] + dirs[d][0], ny = c[1] + dirs[d][1];
        var nk = nx + ',' + ny;
        if (dist[nk] !== undefined) continue;
        if (!passable(nx, ny, t + cd + 1)) continue;
        dist[nk] = cd + 1;
        q.push([nx, ny]);
      }
    }
    return dist;
  }

  var pred = predictRunner();
  // distance to the predicted interception cell
  var distPred = bfsFrom(pred.x, pred.y, t0 + 1);
  // fallback: distance to the runner's current cell
  var distNow = bfsFrom(p.x, p.y, t0 + 1);

  // ---------- choose each hunter's action ----------
  var actions = [];
  for (i = 0; i < o.hunters.length; i++) {
    var h = o.hunters[i];
    var act = 'wait';
    var bestScore = -1e9;
    for (d = 0; d < 4; d++) {
      var nx2 = h.x + dirs[d][0], ny2 = h.y + dirs[d][1];
      if (!passable(nx2, ny2, t0 + 1)) continue;
      var s = 0;
      var dp = distPred[nx2 + ',' + ny2];
      var dn = distNow[nx2 + ',' + ny2];
      if (dp !== undefined) s += 1000 - dp * 10;
      if (dn !== undefined) s += 100 - dn * 3;
      // direct adjacency to runner is valuable
      var manh = Math.abs(nx2 - p.x) + Math.abs(ny2 - p.y);
      s += (40 - manh);
      // slight preference for predicted cell itself
      if (nx2 === pred.x && ny2 === pred.y) s += 15;
      // tiny deterministic tiebreak
      s -= (nx2 * 7 + ny2 * 13) * 0.001;
      if (s > bestScore) { bestScore = s; act = dirs[d][2]; }
    }
    actions.push({ id: h.id, action: act });
  }
  return { actions: actions, memory: null };
}
