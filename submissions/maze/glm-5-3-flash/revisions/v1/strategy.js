// strategy.js — maze runner policy
// Deterministic, synchronous, no external dependencies.
// Core idea: time-aware BFS over the full public map, planning key -> exit,
// grabbing cheap coin detours, while avoiding hunter danger zones and
// gate/trap timing computed from (t + phase) % period.

function decide(o) {
  var W = o.width, H = o.height;
  var me = o.player;
  var t0 = o.tick;

  // ---------- deterministic hash (only used for tie-breaking) ----------
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  var seedH = hashStr(o.seed || '');

  // ---------- geometry / lookup tables ----------
  // gatesAt / trapsAt: build compact maps once per call.
  var gateAt = {}, trapAt = {};
  var i, g;
  for (i = 0; i < o.gates.length; i++) {
    g = o.gates[i];
    gateAt[g.x + ',' + g.y] = g;
  }
  for (i = 0; i < o.traps.length; i++) {
    g = o.traps[i];
    trapAt[g.x + ',' + g.y] = g;
  }
  function gateClosedAt(x, y, t) {
    var gg = gateAt[x + ',' + y];
    if (!gg) return false;
    return ((t + gg.phase) % gg.period) < gg.on;
  }
  function trapActiveAt(x, y, t) {
    var tr = trapAt[x + ',' + y];
    if (!tr) return false;
    return ((t + tr.phase) % tr.period) < tr.on;
  }
  function passable(x, y, t) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    if (o.grid[y][x] !== 0) return false;
    if (gateClosedAt(x, y, t)) return false;
    return true;
  }

  // ---------- danger from hunters ----------
  var invuln = t0 < me.invulnerableUntil;
  var hunterCell = {}, dangerZone = {};
  for (i = 0; i < o.hunters.length; i++) {
    var h = o.hunters[i];
    hunterCell[h.x + ',' + h.y] = true;
    dangerZone[h.x + ',' + h.y] = true;
    if (!invuln) {
      var nb = [[1,0],[-1,0],[0,1],[0,-1]];
      for (var k = 0; k < 4; k++) {
        var hx = h.x + nb[k][0], hy = h.y + nb[k][1];
        if (hx >= 0 && hy >= 0 && hx < W && hy < H) dangerZone[hx + ',' + hy] = true;
      }
    }
  }

  // ---------- time-aware BFS with waiting ----------
  // State: (x, y, t). Waiting is allowed only when standing cell is safe
  // (no active trap at t or t+1). Returns array of {x,y} steps (excluding
  // start, including waits as current-cell repeats) or null.
  var LCM = 840; // lcm of periods 4,5,6,7,8 — state time is modded by this
  function bfs(sx, sy, startT, goals, avoid) {
    var maxT = Math.min(t0 + 500, o.maxTicks + 4);
    var idx = function (x, y, t) { return (((t % LCM) * H + y) * W + x); };
    var size = LCM * H * W;
    var seen = new Uint8Array(size);
    var parent = new Int32Array(size);
    var qx = [], qy = [], qt = [];
    var head = 0;
    var sIdx = idx(sx, sy, startT);
    seen[sIdx] = 1; parent[sIdx] = -1;
    qx.push(sx); qy.push(sy); qt.push(startT);
    var dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (head < qx.length) {
      var x = qx[head], y = qy[head], t = qt[head];
      head++;
      var ci = idx(x, y, t);
      if (goals[x + ',' + y]) {
        // reconstruct
        var path = [];
        var cur = ci;
        while (cur !== -1) {
          var tt = cur % (H * W);
          path.push({ x: tt % W, y: (tt - (tt % W)) / W });
          cur = parent[cur];
        }
        path.reverse();
        path.shift(); // drop start cell
        return path;
      }
      if (t >= maxT) continue;
      // wait (only if standing is safe across the wait)
      if (!trapActiveAt(x, y, t) && !trapActiveAt(x, y, t + 1)) {
        var wi = idx(x, y, t + 1);
        if (!seen[wi]) { seen[wi] = 1; parent[wi] = ci; qx.push(x); qy.push(y); qt.push(t + 1); }
      }
      // moves
      for (var d = 0; d < 4; d++) {
        var nx = x + dirs[d][0], ny = y + dirs[d][1];
        if (!passable(nx, ny, t + 1)) continue;
        if (avoid && avoid[nx + ',' + ny]) continue;
        // stepping onto a trap that is active at arrival is a hit
        if (trapActiveAt(nx, ny, t + 1) && !invuln) continue;
        var ni = idx(nx, ny, t + 1);
        if (!seen[ni]) { seen[ni] = 1; parent[ni] = ci; qx.push(nx); qy.push(ny); qt.push(t + 1); }
      }
    }
    return null;
  }

  // BFS distance map (ignores time except gate closure at fixed tick) —
  // used for cheap planning estimates.
  function distMap(sx, sy, t) {
    var dist = {};
    dist[sx + ',' + sy] = 0;
    var q = [[sx, sy]];
    var head = 0;
    while (head < q.length) {
      var c = q[head]; head++;
      var cd = dist[c[0] + ',' + c[1]];
      var dirs2 = [[1,0],[-1,0],[0,1],[0,-1]];
      for (var d = 0; d < 4; d++) {
        var nx = c[0] + dirs2[d][0], ny = c[1] + dirs2[d][1];
        var nk = nx + ',' + ny;
        if (dist[nk] !== undefined) continue;
        if (!passable(nx, ny, t + cd + 1)) continue;
        dist[nk] = cd + 1;
        q.push([nx, ny]);
      }
    }
    return dist;
  }

  // ---------- pick the goal ----------
  var mem = o.memory || { phase: 'plan' };
  var visitedSet = {};
  for (i = 0; i < o.visited.length; i++) visitedSet[o.visited[i]] = true;

  var keyHere = o.key && o.key.x === me.x && o.key.y === me.y;
  var hasKey = me.hasKey || keyHere;

  var distNow = distMap(me.x, me.y, t0);
  var avoid = invuln ? hunterCell : dangerZone;
  var path = null;
  var goalDesc = 'explore';

  function tryPath(gx, gy, useAvoid) {
    var goals = {};
    goals[gx + ',' + gy] = true;
    return bfs(me.x, me.y, t0, goals, useAvoid ? avoid : null);
  }

  function timeOK(d1, d2) {
    // ticks needed: reach target, then reach exit, minus the tick we spend
    // moving into the exit itself counts; keep a small safety margin.
    return (t0 + d1 + d2) <= o.maxTicks - 2;
  }

  if (hasKey) {
    var dExit = distNow[o.exit.x + ',' + o.exit.y];
    if (dExit !== undefined && (t0 + dExit) <= o.maxTicks - 1) {
      path = tryPath(o.exit.x, o.exit.y, true) || tryPath(o.exit.x, o.exit.y, false);
      goalDesc = 'exit';
    }
  } else if (o.key) {
    var dKey = distNow[o.key.x + ',' + o.key.y];
    var dExitFromKey = null;
    if (dKey !== undefined) {
      var dmKey = distMap(o.key.x, o.key.y, t0 + dKey);
      dExitFromKey = dmKey[o.exit.x + ',' + o.exit.y];
    }
    if (dKey !== undefined && dExitFromKey !== null && dExitFromKey !== undefined &&
        timeOK(dKey, dExitFromKey)) {
      // consider a cheap coin detour before the key
      var bestCoin = null, bestExtra = 9;
      for (i = 0; i < o.coins.length; i++) {
        var c = o.coins[i];
        var dc = distNow[c.x + ',' + c.y];
        if (dc === undefined) continue;
        var dmC = distMap(c.x, c.y, t0 + dc);
        var dKeyFromC = dmC[o.key.x + ',' + o.key.y];
        var dExitFromC = dmC[o.exit.x + ',' + o.exit.y];
        if (dKeyFromC === undefined || dExitFromC === undefined) continue;
        if (!timeOK(dc + dKeyFromC, dExitFromC)) continue;
        var extra = dc + dKeyFromC - dKey;
        if (extra <= bestExtra) {
          var tie = ((seedH + c.x * 131 + c.y * 17 + t0) >>> 0) % 1000;
          if (extra < bestExtra || (extra === bestExtra && bestCoin && tie < bestCoin.tie)) {
            bestCoin = { x: c.x, y: c.y, extra: extra, tie: tie };
            bestExtra = extra;
          }
        }
      }
      var tx, ty;
      if (bestCoin) { tx = bestCoin.x; ty = bestCoin.y; goalDesc = 'coin-then-key'; }
      else { tx = o.key.x; ty = o.key.y; goalDesc = 'key'; }
      path = tryPath(tx, ty, true) || tryPath(tx, ty, false);
    } else {
      // cannot guarantee key + exit in time: try key alone anyway, else coins
      if (dKey !== undefined) {
        path = tryPath(o.key.x, o.key.y, true) || tryPath(o.key.x, o.key.y, false);
        goalDesc = 'key-desperate';
      }
    }
  }

  // fallback: nearest coin, then nearest unexplored cell
  if (!path && o.coins.length) {
    var bc = null, bd = 1e9;
    for (i = 0; i < o.coins.length; i++) {
      var c2 = o.coins[i];
      var dd = distNow[c2.x + ',' + c2.y];
      if (dd !== undefined && dd < bd) { bd = dd; bc = c2; }
    }
    if (bc) {
      path = tryPath(bc.x, bc.y, true) || tryPath(bc.x, bc.y, false);
      goalDesc = 'coin';
    }
  }
  if (!path) {
    // nearest cell we have never visited (frontier exploration)
    var seen2 = {};
    var q2 = [[me.x, me.y]];
    seen2[me.x + ',' + me.y] = true;
    var parent2 = {};
    var found = null;
    var head2 = 0;
    while (head2 < q2.length && !found) {
      var cc = q2[head2]; head2++;
      var dirs3 = [[1,0],[-1,0],[0,1],[0,-1]];
      for (var d3 = 0; d3 < 4; d3++) {
        var nx2 = cc[0] + dirs3[d3][0], ny2 = cc[1] + dirs3[d3][1];
        var nk2 = nx2 + ',' + ny2;
        if (seen2[nk2]) continue;
        if (!passable(nx2, ny2, t0 + q2.length)) { seen2[nk2] = true; continue; }
        seen2[nk2] = true;
        parent2[nk2] = cc[0] + ',' + cc[1];
        if (!visitedSet[nk2]) { found = nk2; break; }
        q2.push([nx2, ny2]);
      }
    }
    if (found) {
      // walk back to a neighbor of current cell
      var chain = [];
      var cur2 = found;
      while (cur2 !== me.x + ',' + me.y) { chain.push(cur2); cur2 = parent2[cur2]; }
      chain.reverse();
      var stepCell = chain[0].split(',');
      var sx2 = parseInt(stepCell[0], 10), sy2 = parseInt(stepCell[1], 10);
      var dirs4 = [[1,0,'right'],[-1,0,'left'],[0,1,'down'],[0,-1,'up']];
      var act2 = 'wait';
      for (var d4 = 0; d4 < 4; d4++) {
        if (me.x + dirs4[d4][0] === sx2 && me.y + dirs4[d4][1] === sy2) { act2 = dirs4[d4][2]; break; }
      }
      // step only if not suicidal
      if (!(dangerZone[sx2 + ',' + sy2] && !invuln) &&
          !(trapActiveAt(sx2, sy2, t0 + 1) && !invuln)) {
        return { action: act2, memory: { phase: goalDesc, lx: sx2, ly: sy2 } };
      }
    }
  }

  if (!path || path.length === 0) {
    // nowhere planned: wait safely
    if (!trapActiveAt(me.x, me.y, t0 + 1) || invuln) return { action: 'wait', memory: mem };
    // step off an about-to-be-active trap
    var es = [[1,0,'right'],[-1,0,'left'],[0,1,'down'],[0,-1,'up']];
    for (i = 0; i < 4; i++) {
      var ex = me.x + es[i][0], ey = me.y + es[i][1];
      if (passable(ex, ey, t0 + 1) && !trapActiveAt(ex, ey, t0 + 1)) {
        return { action: es[i][2], memory: mem };
      }
    }
    return { action: 'wait', memory: mem };
  }

  // ---------- execute next step, with final safety veto ----------
  var step = path[0];
  var act = 'wait';
  if (step.x !== me.x || step.y !== me.y) {
    if (step.x === me.x + 1) act = 'right';
    else if (step.x === me.x - 1) act = 'left';
    else if (step.y === me.y + 1) act = 'down';
    else act = 'up';
  } else {
    // planned wait
    return { action: 'wait', memory: { phase: goalDesc } };
  }

  // veto: stepping exactly onto a hunter's cell is a likely hit; step anyway
  // only if every alternative is worse. Build candidate scores.
  var cands = [];
  var all = [[act, step.x, step.y], ['wait', me.x, me.y],
             ['right', me.x + 1, me.y], ['left', me.x - 1, me.y],
             ['down', me.x, me.y + 1], ['up', me.x, me.y - 1]];
  for (i = 0; i < all.length; i++) {
    var ax = all[i][1], ay = all[i][2];
    if (!passable(ax, ay, t0 + 1) && !(ax === me.x && ay === me.y)) continue;
    var score = 0;
    if (i > 0) score += 5; // slight preference for the planned move
    if (hunterCell[ax + ',' + ay] && !invuln) score += 100;
    if (dangerZone[ax + ',' + ay] && !invuln) score += 20;
    if (trapActiveAt(ax, ay, t0 + 1) && !invuln) score += 80;
    // staying on an active trap right now also hurts
    if (i === 1 && trapActiveAt(me.x, me.y, t0) && !invuln) score += 40;
    cands.push({ a: all[i][0], s: score });
  }
  var best = cands[0];
  for (i = 1; i < cands.length; i++) if (cands[i].s < best.s) best = cands[i];

  return { action: best.a, memory: { phase: goalDesc } };
}
