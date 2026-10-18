// Runner strategy for maze-1.
// Deterministic. Replans every tick from the full observation.
// Route: BFS gradient on open cells (gates are waited out, they block only 2 ticks).
// Action: one-step branch + greedy rollout against a predictive hunter model.

function decide(o) {
  var W = o.width;
  var H = o.height;
  var N = W * H;
  var grid = o.grid;
  var tick0 = o.tick | 0;
  var E = o.hunterEvery | 0;
  if (E < 1) E = 1;
  var px = o.player.x | 0;
  var py = o.player.y | 0;
  var hp0 = o.player.hp | 0;
  var hasKey0 = !!o.player.hasKey;
  var inv0 = o.player.invulnerableUntil | 0;
  var mem = o.memory && typeof o.memory === "object" ? o.memory : null;
  var prevX = mem && typeof mem.lx === "number" ? mem.lx | 0 : px;
  var prevY = mem && typeof mem.ly === "number" ? mem.ly | 0 : py;
  var olderX = mem && typeof mem.px === "number" ? mem.px | 0 : px;
  var olderY = mem && typeof mem.py === "number" ? mem.py | 0 : py;
  var stuck = mem && typeof mem.stuck === "number" ? mem.stuck | 0 : 0;
  var lastA = mem && typeof mem.la === "number" ? mem.la | 0 : -1;
  var ccx = mem && typeof mem.cx === "number" ? mem.cx | 0 : -1;
  var ccy = mem && typeof mem.cy === "number" ? mem.cy | 0 : -1;
  if (prevX === px && prevY === py) stuck += 1;
  else stuck = 0;
  if (stuck > 30) stuck = 30;
  var recent = [];
  if (mem && Array.isArray(mem.r)) {
    for (var ri = 0; ri < mem.r.length && ri < 10; ri++) {
      if (typeof mem.r[ri] === "number") recent.push(mem.r[ri] | 0);
    }
  }
  var revisit = 0;
  for (var ri2 = 0; ri2 < recent.length; ri2++) if (recent[ri2] === py * W + px) revisit = 1;
  var prevStall = mem && typeof mem.stall === "number" ? mem.stall | 0 : 0;
  var stall = revisit ? prevStall + 1 : (prevStall > 0 ? prevStall - 1 : 0);
  if (stall > 40) stall = 40;
  var cycle = px === olderX && py === olderY && (px !== prevX || py !== prevY);

  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];
  var NAME = ["up", "right", "down", "left", "wait"];

  var isGate = new Uint8Array(N);
  var gateP = new Int16Array(N);
  var gatePh = new Int16Array(N);
  var gateOn = new Int16Array(N);
  var isTrap = new Uint8Array(N);
  var trapP = new Int16Array(N);
  var trapPh = new Int16Array(N);
  var trapOn = new Int16Array(N);
  var coin0 = new Uint8Array(N);
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
  for (i = 0; i < o.traps.length; i++) {
    var tr = o.traps[i];
    var tri = (tr.y | 0) * W + (tr.x | 0);
    if (tri < 0 || tri >= N) continue;
    isTrap[tri] = 1;
    trapP[tri] = tr.period | 0;
    trapPh[tri] = tr.phase | 0;
    trapOn[tri] = tr.on | 0;
  }
  var coinList = [];
  for (i = 0; i < o.coins.length; i++) {
    var c = o.coins[i];
    var ci0 = (c.y | 0) * W + (c.x | 0);
    if (ci0 < 0 || ci0 >= N || coin0[ci0]) continue;
    coin0[ci0] = 1;
    coinList.push(ci0);
  }

  var keyI = !hasKey0 && o.key ? (o.key.y | 0) * W + (o.key.x | 0) : -1;
  var exitI = (o.exit.y | 0) * W + (o.exit.x | 0);
  var startI = py * W + px;
  var prevI = prevY * W + prevX;

  function mod(a, p) {
    if (p <= 0) return 0;
    var m = a % p;
    return m < 0 ? m + p : m;
  }
  function gateClosed(iCell, tk) {
    if (!isGate[iCell]) return false;
    return mod(tk + gatePh[iCell], gateP[iCell]) < gateOn[iCell];
  }
  function trapHot(iCell, tk) {
    if (!isTrap[iCell]) return false;
    return mod(tk + trapPh[iCell], trapP[iCell]) < trapOn[iCell];
  }
  function canEnter(iCell, tk) {
    if (iCell < 0 || iCell >= N) return false;
    var x = iCell % W;
    var y = (iCell / W) | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    if (grid[y][x] !== 0) return false;
    if (gateClosed(iCell, tk)) return false;
    return true;
  }
  function bfsFrom(src) {
    var dist = new Int16Array(N);
    for (var k = 0; k < N; k++) dist[k] = -1;
    if (src < 0 || src >= N) return dist;
    var sx = src % W;
    var sy = (src / W) | 0;
    if (sx < 0 || sy < 0 || sx >= W || sy >= H || grid[sy][sx] !== 0) return dist;
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
        q[qt++] = ni;
      }
    }
    return dist;
  }
  function bfsAvoid(src, blocked) {
    var dist = new Int16Array(N);
    for (var k = 0; k < N; k++) dist[k] = -1;
    if (src < 0 || src >= N) return dist;
    var sx = src % W;
    var sy = (src / W) | 0;
    if (grid[sy][sx] !== 0) return dist;
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
        if (blocked[ni]) continue;
        dist[ni] = cd + 1;
        q[qt++] = ni;
      }
    }
    return dist;
  }
  function bfsMulti(srcList) {
    var dist = new Int16Array(N);
    for (var k = 0; k < N; k++) dist[k] = -1;
    var q = new Int32Array(N);
    var qh = 0;
    var qt = 0;
    for (var s = 0; s < srcList.length; s++) {
      var si = srcList[s];
      if (si < 0 || si >= N || dist[si] !== -1) continue;
      var x = si % W;
      var y = (si / W) | 0;
      if (grid[y][x] !== 0) continue;
      dist[si] = 0;
      q[qt++] = si;
    }
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
        q[qt++] = ni;
      }
    }
    return dist;
  }

  var distExit = bfsFrom(exitI);
  var distKey = keyI >= 0 ? bfsFrom(keyI) : null;
  var keyToExit = keyI >= 0 && distExit[keyI] >= 0 ? distExit[keyI] : 0;

  function mainDist(iCell, hasKey) {
    if (hasKey || !distKey) {
      var de = distExit[iCell];
      return de < 0 ? 100000 : de;
    }
    var dk = distKey[iCell];
    if (dk < 0) return 100000;
    return dk + keyToExit;
  }

  var hunters = [];
  var hIdx = [];
  for (i = 0; i < o.hunters.length; i++) {
    var h = o.hunters[i];
    hunters.push({ id: h.id | 0, x: h.x | 0, y: h.y | 0 });
    hIdx.push((h.y | 0) * W + (h.x | 0));
  }
  var distH = bfsMulti(hIdx);
  var minHD = distH[startI];
  if (minHD < 0) minHD = 999;

  var remain = (o.maxTicks | 0) - tick0;
  var mainNow = mainDist(startI, hasKey0);
  var panic = remain <= mainNow + 10;

  var mandatory = !hasKey0 && keyI >= 0 ? keyI : exitI;
  var navGoal = mandatory;
  var chasingCoin = 0;
  var distPlayer = bfsFrom(startI);
  var distMand = !hasKey0 && distKey ? distKey : distExit;

  if (!panic && hp0 >= 2 && minHD >= 4 && coinList.length) {
    var base = distMand[startI];
    var budget = hp0 >= 3 ? 16 : 8;
    var keep = -1;
    if (ccx >= 0 && ccy >= 0) {
      var kept = (ccy * W + ccx) | 0;
      if (kept >= 0 && kept < N && coin0[kept]) keep = kept;
    }
    var best = -1;
    var bestExtra = 9999;
    var bestDp = 9999;
    for (i = 0; i < coinList.length; i++) {
      var ci = coinList[i];
      var dp = distPlayer[ci];
      var dm = distMand[ci];
      if (dp < 0 || dm < 0 || base < 0) continue;
      var extra = dp + dm - base;
      if (ci === keep && extra <= budget + 6) {
        best = ci;
        bestExtra = extra;
        break;
      }
      if (extra < bestExtra || (extra === bestExtra && dp < bestDp)) {
        bestExtra = extra;
        bestDp = dp;
        best = ci;
      }
    }
    if (best >= 0 && (best === keep ? bestExtra <= budget + 6 : bestExtra <= budget)) {
      navGoal = best;
      chasingCoin = 1;
    }
  }

  var distNav = bfsFrom(navGoal);
  var tabu = new Uint8Array(N);
  if (stall >= 5) {
    chasingCoin = 0;
    navGoal = mandatory;
    distNav = distMand;
    for (var ti = 0; ti < recent.length; ti++) {
      var rc = recent[ti];
      if (rc >= 0 && rc < N && rc !== exitI && rc !== keyI) tabu[rc] = 1;
    }
  }

  var spaceStamp = new Int32Array(N);
  var spaceStampId = 1;
  var spaceQ = new Int32Array(80);
  var spaceD = new Int16Array(80);
  function space(iCell) {
    spaceStampId++;
    if (spaceStampId >= 0x7fffffff) {
      spaceStamp = new Int32Array(N);
      spaceStampId = 1;
    }
    var qh = 0;
    var qt = 0;
    spaceQ[qt] = iCell;
    spaceD[qt] = 0;
    qt++;
    spaceStamp[iCell] = spaceStampId;
    var cnt = 0;
    while (qh < qt) {
      var cur = spaceQ[qh];
      var cd = spaceD[qh];
      qh++;
      cnt++;
      if (cd >= 4) continue;
      var x = cur % W;
      var y = (cur / W) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d];
        var ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (grid[ny][nx] !== 0) continue;
        var ni = ny * W + nx;
        if (spaceStamp[ni] === spaceStampId) continue;
        if (qt >= spaceQ.length) continue;
        spaceStamp[ni] = spaceStampId;
        spaceQ[qt] = ni;
        spaceD[qt] = cd + 1;
        qt++;
      }
    }
    return cnt;
  }
  function degree(iCell) {
    var x = iCell % W;
    var y = (iCell / W) | 0;
    var n = 0;
    for (var d = 0; d < 4; d++) {
      var nx = x + DX[d];
      var ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (grid[ny][nx] === 0) n++;
    }
    return n;
  }
  function resolve(iCell, action, tk) {
    if (action < 0 || action >= 4) return iCell;
    var x = iCell % W;
    var y = (iCell / W) | 0;
    var ni = (y + DY[action]) * W + (x + DX[action]);
    if (!canEnter(ni, tk)) return iCell;
    return ni;
  }
  function gradient(iCell, field, tk) {
    var best = iCell;
    var bd = field[iCell];
    if (bd < 0) bd = 30000;
    var x = iCell % W;
    var y = (iCell / W) | 0;
    for (var d = 0; d < 4; d++) {
      var nx = x + DX[d];
      var ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var ni = ny * W + nx;
      if (!canEnter(ni, tk)) continue;
      var nd = field[ni];
      if (nd < 0) continue;
      if (nd < bd) {
        bd = nd;
        best = ni;
      }
    }
    return best;
  }
  function bfsTree(src) {
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
  function pathAlong(iCell, field) {
    var path = [iCell];
    var seen = new Uint8Array(N);
    seen[iCell] = 1;
    var cur = iCell;
    var guard = 0;
    while (guard++ < N) {
      var bd = field[cur];
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
        if (seen[ni]) continue;
        if (field[ni] === bd - 1) {
          next = ni;
          break;
        }
      }
      if (next < 0) break;
      seen[next] = 1;
      path.push(next);
      cur = next;
    }
    return path;
  }
  function stepFromTree(h, tree, target, tk) {
    var hi = h.y * W + h.x;
    if (target === hi || tree.dist[target] < 0) return { id: h.id, x: h.x, y: h.y };
    var cur = target;
    var guard = 0;
    while (tree.parent[cur] !== hi && tree.parent[cur] !== -1 && guard++ < N) cur = tree.parent[cur];
    if (tree.parent[cur] !== hi) return { id: h.id, x: h.x, y: h.y };
    if (!canEnter(cur, tk)) return { id: h.id, x: h.x, y: h.y };
    return { id: h.id, x: cur % W, y: (cur / W) | 0 };
  }
  function hunterMoves(hs, playerI, field, tk) {
    var out = new Array(hs.length);
    if (((tk + 1) % E) !== 0) {
      for (var k = 0; k < hs.length; k++) out[k] = { id: hs[k].id, x: hs[k].x, y: hs[k].y };
      return out;
    }
    var pred = gradient(playerI, field, tk);
    var path = pathAlong(playerI, field);
    var trees = new Array(hs.length);
    for (var k = 0; k < hs.length; k++) trees[k] = bfsTree(hs[k].y * W + hs[k].x);
    var assigned = new Uint8Array(hs.length);
    var target = new Int32Array(hs.length);
    for (var k = 0; k < hs.length; k++) target[k] = pred;
    var x = playerI % W;
    var y = (playerI / W) | 0;
    var options = [pred];
    for (var d = 0; d < 4; d++) {
      var nx = x + DX[d];
      var ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var ni = ny * W + nx;
      if (!canEnter(ni, tk) || ni === pred) continue;
      var nd = field[ni];
      var cd = field[playerI];
      if (cd < 0) cd = 30000;
      if (nd < 0) nd = 30000;
      if (nd <= cd) options.push(ni);
    }
    for (var oi = 0; oi < options.length; oi++) {
      var pick = -1;
      var pd = 999999;
      for (var k = 0; k < hs.length; k++) {
        if (assigned[k]) continue;
        var distP = trees[k].dist[playerI];
        if (distP < 0 || distP > E + 1) continue;
        var dcell = trees[k].dist[options[oi]];
        if (dcell < 0 || dcell > E + 1) continue;
        if (dcell < pd) {
          pd = dcell;
          pick = k;
        }
      }
      if (pick >= 0) {
        target[pick] = options[oi];
        assigned[pick] = 1;
      }
    }
    for (var k = 0; k < hs.length; k++) {
      if (assigned[k]) continue;
      var tree = trees[k];
      var bestI = path.length > 1 ? path.length - 1 : 0;
      var found = -1;
      var bestSlack = -999999;
      var slackI = bestI;
      var late = k === hs.length - 1 && hs.length >= 2;
      for (var pi = 1; pi < path.length; pi++) {
        var distC = tree.dist[path[pi]];
        if (distC < 0) continue;
        var avail = ((pi - 1) / E | 0) + 1;
        var slack = avail - distC;
        if (slack >= 0) {
          if (!late) {
            found = pi;
            break;
          }
          found = pi;
        }
        if (slack > bestSlack) {
          bestSlack = slack;
          slackI = pi;
        }
      }
      var idx = found >= 0 ? found : slackI;
      if (late && found >= 0) idx = found;
      if (k > 0 && idx + E < path.length) idx = idx + E;
      if (idx >= path.length) idx = path.length - 1;
      if (idx < 0) idx = 0;
      var dPred = tree.dist[pred];
      target[k] = dPred >= 0 && dPred <= 1 ? pred : path[idx];
      if (target[k] === exitI && path.length >= 2) target[k] = path[path.length - 2];
    }
    for (var k = 0; k < hs.length; k++) out[k] = stepFromTree(hs[k], trees[k], target[k], tk);
    return out;
  }
  function overlap(landing, ends) {
    for (var k = 0; k < ends.length; k++) {
      if (ends[k].y * W + ends[k].x === landing) return true;
    }
    return false;
  }
  function hurt(landing, ends, tk, inv) {
    if (tk < inv) return false;
    if (trapHot(landing, tk)) return true;
    if (overlap(landing, ends)) return true;
    return false;
  }
  function worstCells(hs, tk) {
    var mark = new Uint8Array(N);
    for (var k = 0; k < hs.length; k++) {
      var x = hs[k].x;
      var y = hs[k].y;
      var hi = y * W + x;
      if (hi >= 0 && hi < N) mark[hi] = 1;
      if (((tk + 1) % E) !== 0) continue;
      for (var d = 0; d < 4; d++) {
        var ni = (y + DY[d]) * W + (x + DX[d]);
        if (canEnter(ni, tk)) mark[ni] = 1;
      }
    }
    return mark;
  }

  if (hasKey0) {
    for (var dw = 0; dw < 4; dw++) {
      if (resolve(startI, dw, tick0) === exitI) {
        return pack(dw, navGoal, chasingCoin);
      }
    }
  }

  function scoreAction(iCell, hs, hp, hasKey, inv, tk, prevCell, field, coinMask, action, ends, worst) {
    if (hasKey && resolve(iCell, action, tk) === exitI) return 1e12 - action;
    var landing = resolve(iCell, action, tk);
    var nd = field[landing];
    if (nd < 0) nd = 8000;
    var curD = field[iCell];
    if (curD < 0) curD = 8000;
    var s = -nd * 100;
    if (coinMask[landing] && nd < curD) s += 60;
    if (!hasKey && landing === keyI) s += 250;
    if (hurt(landing, ends, tk, inv)) {
      if (hp <= 1) s -= 1e9;
      else if (panic) s -= 280;
      else if (hp === 2) s -= 3800;
      else s -= 1600;
    }
    if (action === 4) s -= 35;
    if (landing === prevCell && prevCell !== iCell) s -= (cycle && iCell === startI ? 8000 : 420);
    if (stuck >= 6 && action === lastA && iCell === startI && action === 4) s -= 80;
    var important = landing === exitI || landing === keyI || landing === navGoal;
    if (!important && degree(landing) <= 1) s -= hp <= 2 ? 900 : 180;
    if (hp <= 2 && !important) s += space(landing) * 18;
    if (stall >= 5 && tabu[landing] && landing !== exitI) s -= 4500;
    s -= action * 0.001;
    return s;
  }

  function chooseGreedy(iCell, hs, hp, hasKey, inv, tk, prevCell, field, coinMask) {
    var ends = hunterMoves(hs, iCell, field, tk);
    var worst = hp <= 1 && tk >= inv ? worstCells(hs, tk) : null;
    var bestA = 4;
    var bestS = -1e18;
    for (var a = 0; a < 5; a++) {
      var s = scoreAction(iCell, hs, hp, hasKey, inv, tk, prevCell, field, coinMask, a, ends, worst);
      if (s > bestS) {
        bestS = s;
        bestA = a;
      }
    }
    return bestA;
  }

  function rollout(first, field, coinMask) {
    var simI = startI;
    var hp = hp0;
    var hasKey = hasKey0;
    var inv = inv0;
    var tk = tick0;
    var hs = new Array(hunters.length);
    for (var k = 0; k < hunters.length; k++) hs[k] = { id: hunters[k].id, x: hunters[k].x, y: hunters[k].y };
    var coins = new Uint8Array(coinMask);
    var got = 0;
    var hits = 0;
    var prevCell = prevI;
    var won = 0;
    var dead = 0;
    var steps = 0;
    var horizon = remain > 12 ? 12 : remain;
    if (horizon < 1) horizon = 1;
    var activeField = field;

    while (steps < horizon && !won && !dead) {
      var action;
      if (steps === 0) action = first;
      else {
        var endsPick = hunterMoves(hs, simI, activeField, tk);
        var blocked = new Uint8Array(N);
        for (var bi = 0; bi < endsPick.length; bi++) {
          var bci = endsPick[bi].y * W + endsPick[bi].x;
          if (bci >= 0 && bci < N) blocked[bci] = 1;
        }
        var goalR = hasKey ? exitI : keyI >= 0 ? keyI : exitI;
        if (goalR >= 0 && goalR < N) blocked[goalR] = 0;
        var reach = bfsAvoid(goalR, blocked);
        var cut = reach[simI] < 0;
        action = 4;
        var bestS = -1e18;
        for (var a = 0; a < 5; a++) {
          var s = scoreAction(simI, hs, hp, hasKey, inv, tk, prevCell, activeField, coins, a, endsPick, null);
          var landingA = resolve(simI, a, tk);
          if (reach[landingA] < 0 && reach[simI] >= 0) s -= 15000;
          if (cut) s += space(landingA) * 70;
          if (s > bestS) {
            bestS = s;
            action = a;
          }
        }
      }
      var from = simI;
      var landing = resolve(simI, action, tk);
      var ends = steps === 0 ? hunterMoves(hs, from, activeField, tk) : endsPick;
      if (coins[landing]) {
        coins[landing] = 0;
        got++;
      }
      if (!hasKey && landing === keyI) {
        hasKey = true;
        activeField = distExit;
      } else if (chasingCoin && hasKey === false && landing === navGoal) {
        activeField = distMand;
      } else if (chasingCoin && landing === navGoal) {
        activeField = distExit;
      }
      if (hasKey && landing === exitI) {
        won = 1;
        simI = landing;
        steps++;
        break;
      }
      simI = landing;
      hs = ends;
      if (hurt(landing, ends, tk, inv)) {
        hp -= 1;
        hits += 1;
        inv = tk + 3;
        if (hp <= 0) {
          hp = 0;
          dead = 1;
        }
      }
      prevCell = from;
      tk += 1;
      steps++;
    }

    var firstLanding = resolve(startI, first, tick0);
    var navLeft = activeField[simI];
    if (navLeft < 0) navLeft = 9999;
    return {
      won: won,
      dead: dead,
      hits: hits,
      hp: hp,
      coins: got,
      nav: navLeft,
      main: mainDist(simI, hasKey),
      steps: steps,
      action: first,
      back: firstLanding === prevI && firstLanding !== startI ? 1 : 0
    };
  }

  function better(a, b) {
    if (a.won !== b.won) return a.won > b.won;
    if (a.won) {
      if (a.steps !== b.steps) return a.steps < b.steps;
      if (a.hp !== b.hp) return a.hp > b.hp;
      if (a.coins !== b.coins) return a.coins > b.coins;
      return a.action < b.action;
    }
    if (a.dead !== b.dead) return a.dead < b.dead;
    if (a.dead) {
      if (a.steps !== b.steps) return a.steps > b.steps;
      return a.action < b.action;
    }
    var hitW = hp0 <= 1 ? 60 : panic ? 5 : hp0 === 2 ? 28 : 16;
    var coinW = panic ? 1 : 12;
    var backW = cycle ? 400 : 70;
    var sa = -a.main * 10 - a.hits * hitW + a.coins * coinW + a.hp * 2 - a.nav * 0.02 - a.back * backW;
    var sb = -b.main * 10 - b.hits * hitW + b.coins * coinW + b.hp * 2 - b.nav * 0.02 - b.back * backW;
    if (sa !== sb) return sa > sb;
    return a.action < b.action;
  }

  function search(field) {
    var best = null;
    for (var a = 0; a < 5; a++) {
      var r = rollout(a, field, coin0);
      if (!best || better(r, best)) best = r;
    }
    return best;
  }

  var best = search(distNav);
  if (chasingCoin && best && best.dead) {
    chasingCoin = 0;
    navGoal = mandatory;
    distNav = bfsFrom(navGoal);
    best = search(distNav);
  }

  var actionI = best ? best.action : 4;
  actionI = applySafety(actionI);
  actionI = forceMove(actionI, best);

  return pack(actionI, navGoal, chasingCoin);

  function forceMove(actionI, best) {
    var landing0 = resolve(startI, actionI, tick0);
    if (landing0 !== startI) return actionI;
    var dying = best && best.dead;
    if (stuck < 3 && !dying) return actionI;
    var bd = distNav[startI];
    var x = startI % W;
    var y = (startI / W) | 0;
    var waitingGate = false;
    if (bd > 0) {
      var sawClosed = false;
      var sawOpen = false;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d];
        var ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (grid[ny][nx] !== 0) continue;
        var ni = ny * W + nx;
        if (distNav[ni] !== bd - 1) continue;
        if (canEnter(ni, tick0)) sawOpen = true;
        else if (isGate[ni] && gateClosed(ni, tick0)) sawClosed = true;
      }
      waitingGate = sawClosed && !sawOpen;
    }
    if (waitingGate && !dying) return actionI;
    var ends = hunterMoves(hunters, startI, distNav, tick0);
    var fb = actionI;
    var fbS = -1e18;
    for (var a = 0; a < 4; a++) {
      var landing = resolve(startI, a, tick0);
      if (landing === startI) continue;
      var nd = distNav[landing];
      if (nd < 0) nd = 9000;
      var s = space(landing) * 40 - nd * 15 - a;
      if (hurt(landing, ends, tick0, inv0)) s -= hp0 <= 1 ? 1e7 : 800;
      if (tabu[landing]) s -= 500;
      if (s > fbS) {
        fbS = s;
        fb = a;
      }
    }
    return fb;
  }

  function applySafety(actionI) {
    if (tick0 < inv0 || hp0 > 1) return actionI;
    var ends = hunterMoves(hunters, startI, distNav, tick0);
    function lethal(a) {
      return hurt(resolve(startI, a, tick0), ends, tick0, inv0);
    }
    if (!lethal(actionI)) return actionI;
    var fb = -1;
    var fbS = -1e18;
    for (var a = 0; a < 5; a++) {
      if (lethal(a)) continue;
      var landing = resolve(startI, a, tick0);
      var nd = distNav[landing];
      if (nd < 0) nd = 9000;
      var s = -nd * 100 - a;
      if (landing === prevI && landing !== startI) s -= cycle ? 5000 : 400;
      if (s > fbS) {
        fbS = s;
        fb = a;
      }
    }
    return fb >= 0 ? fb : actionI;
  }

  function pack(actionI, goal, chase) {
    if (actionI < 0 || actionI > 4) actionI = 4;
    var cx = -1;
    var cy = -1;
    if (chase && goal >= 0) {
      cx = goal % W;
      cy = (goal / W) | 0;
    }
    var nextR = [];
    for (var rj = 0; rj < recent.length; rj++) nextR.push(recent[rj]);
    nextR.push(startI);
    if (nextR.length > 10) nextR = nextR.slice(nextR.length - 10);
    return {
      action: NAME[actionI],
      memory: {
        lx: px,
        ly: py,
        px: prevX,
        py: prevY,
        stuck: stuck,
        stall: stall,
        r: nextR,
        cx: cx,
        cy: cy,
        la: actionI
      }
    };
  }
}