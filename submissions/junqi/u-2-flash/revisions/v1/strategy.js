/* 将军棋策略 (junqi-2)
 * 同步、确定性、无依赖。长期状态保存在本模块顶层变量中（每局 Worker 独立初始化）。
 */
'use strict';

var G = null;

var DIRS = [
  [0, -1, 'up'],
  [1, 0, 'right'],
  [0, 1, 'down'],
  [-1, 0, 'left']
];

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < G.W && y < G.H;
}

function sameTeam(id) {
  if (id < 0) return false;
  var t = G.teamOf[id];
  return t !== undefined && t === G.myTeam;
}

function initGame(o) {
  G = {
    W: o.width,
    H: o.height,
    terrain: [],
    myGeneral: { x: o.you.general.x, y: o.you.general.y },
    enemyGenerals: [],
    objDist: null,
    myId: o.you.id,
    myTeam: o.you.team,
    teamOf: [],
    marchPos: null
  };
  for (var y = 0; y < G.H; y++) {
    var row = [];
    for (var x = 0; x < G.W; x++) row.push(-1);
    G.terrain.push(row);
  }
}

function updateState(o) {
  var y, x, i;
  for (y = 0; y < G.H; y++) {
    var trow = o.terrain[y];
    for (x = 0; x < G.W; x++) {
      var t = trow[x];
      if (t >= 0) G.terrain[y][x] = t;
    }
  }
  G.myGeneral = { x: o.you.general.x, y: o.you.general.y };
  G.myId = o.you.id;
  G.myTeam = o.you.team;
  G.teamOf = [];
  for (i = 0; i < o.players.length; i++) {
    G.teamOf[o.players[i].id] = o.players[i].team;
  }
  G.marchPos = null;

  G.enemyGenerals = [];
  for (y = 0; y < G.H; y++) {
    for (x = 0; x < G.W; x++) {
      if (G.terrain[y][x] === 3 && !(x === G.myGeneral.x && y === G.myGeneral.y)) {
        if (o.terrain[y][x] >= 0 && o.terrain[y][x] !== 3) {
          G.terrain[y][x] = o.terrain[y][x];
          continue;
        }
        if (o.terrain[y][x] === 3 && o.owner[y][x] >= 0) {
          if (o.owner[y][x] === G.myId || sameTeam(o.owner[y][x])) continue;
        }
        G.enemyGenerals.push({ x: x, y: y });
      }
    }
  }

  // 距离场每 4 tick 重算一次即可（城市静止、将军极少移动）
  if (G.objDist === null || o.tick % 4 === 0) {
    computeObjectiveDist(o);
  }
}

function computeObjectiveDist(o) {
  var n = G.W * G.H;
  var dist = new Array(n);
  var queue = new Int32Array(n + 4);
  var head = 0, tail = 0;
  var y, x, i;

  for (y = 0; y < G.H; y++) {
    for (x = 0; x < G.W; x++) {
      i = y * G.W + x;
      var terr = G.terrain[y][x];
      var isObj = false;
      if (terr === 3 && !(x === G.myGeneral.x && y === G.myGeneral.y)) {
        isObj = true;
      } else if (terr === 2) {
        var owner = o.owner[y][x];
        if (owner === G.myId || (owner >= 0 && sameTeam(owner))) {
          isObj = false;
        } else {
          isObj = true;
        }
      }
      if (isObj) {
        dist[i] = 0;
        queue[tail++] = i;
      } else {
        dist[i] = -1;
      }
    }
  }

  while (head < tail) {
    var cur = queue[head++];
    var cx = cur % G.W;
    var cy = (cur / G.W) | 0;
    var d = dist[cur] + 1;
    if (cy > 0) {
      var ni = cur - G.W;
      if (G.terrain[cy - 1][cx] !== 1 && dist[ni] === -1) { dist[ni] = d; queue[tail++] = ni; }
    }
    if (cx < G.W - 1) {
      var ni2 = cur + 1;
      if (G.terrain[cy][cx + 1] !== 1 && dist[ni2] === -1) { dist[ni2] = d; queue[tail++] = ni2; }
    }
    if (cy < G.H - 1) {
      var ni3 = cur + G.W;
      if (G.terrain[cy + 1][cx] !== 1 && dist[ni3] === -1) { dist[ni3] = d; queue[tail++] = ni3; }
    }
    if (cx > 0) {
      var ni4 = cur - 1;
      if (G.terrain[cy][cx - 1] !== 1 && dist[ni4] === -1) { dist[ni4] = d; queue[tail++] = ni4; }
    }
  }

  G.objDist = dist;
}

function objectiveBias(x, y) {
  var d = G.objDist[y * G.W + x];
  if (d === Infinity) return 0;
  var b = 40 - d;
  return b > 0 ? b * 5 : 0;
}

function unknownNeighbors(x, y) {
  var c = 0;
  for (var i = 0; i < 4; i++) {
    var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
    if (inBounds(nx, ny) && G.terrain[ny][nx] === -1) c++;
  }
  return c;
}

function landValue(x, y) {
  var c = 0;
  for (var i = 0; i < 4; i++) {
    var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
    if (inBounds(nx, ny) && G.terrain[ny][nx] !== 1) c++;
  }
  return c;
}

function expansionScore(x, y) {
  return 100 + unknownNeighbors(x, y) * 25 + landValue(x, y) * 3 + objectiveBias(x, y);
}

function cloneGrid(g) {
  var out = [];
  for (var y = 0; y < G.H; y++) out.push(g[y].slice());
  return out;
}

function dirTo(from, to) {
  if (to.x === from.x && to.y === from.y - 1) return 'up';
  if (to.x === from.x + 1 && to.y === from.y) return 'right';
  if (to.x === from.x && to.y === from.y + 1) return 'down';
  return 'left';
}

function applyMove(o, simOwner, simArmy, from, to, half) {
  var n = simArmy[from.y][from.x];
  var k = half ? Math.floor(n / 2) : n - 1;
  if (k < 1) return;
  simArmy[from.y][from.x] -= k;
  var owner = simOwner[to.y][to.x];
  var def = simArmy[to.y][to.x];
  if (owner === G.myId || sameTeam(owner)) {
    simArmy[to.y][to.x] += k;
  } else {
    if (k > def) {
      simOwner[to.y][to.x] = G.myId;
      simArmy[to.y][to.x] = k - def;
    } else {
      simArmy[to.y][to.x] = def - k;
    }
  }
}

function defendGeneral(o, simOwner, simArmy, moves) {
  var gx = G.myGeneral.x, gy = G.myGeneral.y;
  var adjEnemies = [];
  var i;
  for (i = 0; i < 4; i++) {
    var tx = gx + DIRS[i][0], ty = gy + DIRS[i][1];
    if (!inBounds(tx, ty)) continue;
    var owner = simOwner[ty][tx];
    if (owner >= 0 && owner !== G.myId && !sameTeam(owner)) {
      adjEnemies.push({ x: tx, y: ty, army: simArmy[ty][tx] });
    }
  }
  if (!adjEnemies.length) return;

  for (var e = 0; e < adjEnemies.length; e++) {
    if (moves.length >= 4) return;
    var en = adjEnemies[e];
    if (en.army < 0) continue;
    var best = null;
    for (i = 0; i < 4; i++) {
      var sx = en.x + DIRS[i][0], sy = en.y + DIRS[i][1];
      if (inBounds(sx, sy) && simOwner[sy][sx] === G.myId && simArmy[sy][sx] - 1 > en.army) {
        if (!best || simArmy[sy][sx] > simArmy[best.y][best.x]) best = { x: sx, y: sy };
      }
    }
    if (best) {
      moves.push({ from: best, dir: dirTo(best, en), half: false });
      applyMove(o, simOwner, simArmy, best, en, false);
    }
  }

  var gArmy = simArmy[gy][gx];
  for (var e2 = 0; e2 < adjEnemies.length; e2++) {
    var en2 = adjEnemies[e2];
    if (simOwner[en2.y][en2.x] === G.myId) continue;
    if (en2.army >= 2 && en2.army - 1 > gArmy) {
      while (moves.length < 4 && simArmy[gy][gx] < en2.army) {
        var fb = null;
        for (i = 0; i < 4; i++) {
          var fx = gx + DIRS[i][0], fy = gy + DIRS[i][1];
          if (inBounds(fx, fy) && simOwner[fy][fx] === G.myId && simArmy[fy][fx] >= 2) {
            if (!fb || simArmy[fy][fx] > simArmy[fb.y][fb.x]) fb = { x: fx, y: fy };
          }
        }
        if (!fb) break;
        moves.push({ from: fb, dir: dirTo(fb, { x: gx, y: gy }), half: false });
        applyMove(o, simOwner, simArmy, fb, { x: gx, y: gy }, false);
      }
      gArmy = simArmy[gy][gx];
    }
  }
}

function killGeneral(o, simOwner, simArmy, moves) {
  for (var gi = 0; gi < G.enemyGenerals.length; gi++) {
    if (moves.length >= 4) return;
    var g = G.enemyGenerals[gi];
    if (o.terrain[g.y][g.x] >= 0 && o.terrain[g.y][g.x] !== 3) continue;
    var owner = simOwner[g.y][g.x];
    if (owner === G.myId || (owner >= 0 && sameTeam(owner))) continue;
    var best = null;
    for (var i = 0; i < 4; i++) {
      var sx = g.x + DIRS[i][0], sy = g.y + DIRS[i][1];
      if (inBounds(sx, sy) && simOwner[sy][sx] === G.myId) {
        var def = simArmy[g.y][g.x];
        if (def >= 0 && simArmy[sy][sx] - 1 > def) {
          if (!best || simArmy[sy][sx] > simArmy[best.y][best.x]) best = { x: sx, y: sy };
        }
      }
    }
    if (best) {
      moves.push({ from: best, dir: dirTo(best, g), half: false });
      applyMove(o, simOwner, simArmy, best, g, false);
      G.terrain[g.y][g.x] = 2;
      G.enemyGenerals.splice(gi, 1);
      gi--;
    }
  }
}

function captureCity(o, simOwner, simArmy, moves) {
  var bestCity = null;
  var bestSiege = null;
  var bestGarrison = 0;
  var bestScore = -Infinity;

  for (var y = 0; y < G.H; y++) {
    for (var x = 0; x < G.W; x++) {
      if (G.terrain[y][x] !== 2) continue;
      if (o.owner[y][x] !== -1) continue;
      var siege = null;
      for (var i = 0; i < 4; i++) {
        var sx = x + DIRS[i][0], sy = y + DIRS[i][1];
        if (inBounds(sx, sy) && simOwner[sy][sx] === G.myId) {
          if (!siege || simArmy[sy][sx] > simArmy[siege.y][siege.x]) siege = { x: sx, y: sy };
        }
      }
      if (!siege) continue;
      var garrison = simArmy[y][x];
      if (garrison < 0) continue;
      var capturable = simArmy[siege.y][siege.x] >= garrison + 2;
      var score = simArmy[siege.y][siege.x] + objectiveBias(x, y) + (capturable ? 100000 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestCity = { x: x, y: y };
        bestSiege = siege;
        bestGarrison = garrison;
      }
    }
  }

  if (!bestCity) return;

  var cx = bestCity.x, cy = bestCity.y;
  var siege = bestSiege;
  var garrison = bestGarrison;

  if (simArmy[siege.y][siege.x] >= garrison + 2) {
    moves.push({ from: siege, dir: dirTo(siege, bestCity), half: false });
    applyMove(o, simOwner, simArmy, siege, bestCity, false);
    return;
  }

  var fed = 0;
  while (moves.length < 4 && fed < 3 && simArmy[siege.y][siege.x] < garrison + 2) {
    var fb = null;
    for (var i = 0; i < 4; i++) {
      var fx = siege.x + DIRS[i][0], fy = siege.y + DIRS[i][1];
      if (inBounds(fx, fy) && simOwner[fy][fx] === G.myId && simArmy[fy][fx] >= 3) {
        if (fx === cx && fy === cy) continue;
        if (!fb || simArmy[fy][fx] > simArmy[fb.y][fb.x]) fb = { x: fx, y: fy };
      }
    }
    if (!fb) break;
    if (simArmy[fb.y][fb.x] < 5 && simArmy[siege.y][siege.x] < 10) break;
    moves.push({ from: fb, dir: dirTo(fb, siege), half: false });
    applyMove(o, simOwner, simArmy, fb, siege, false);
    fed++;
  }

  if (moves.length < 4 && simArmy[siege.y][siege.x] >= garrison + 2) {
    moves.push({ from: siege, dir: dirTo(siege, bestCity), half: false });
    applyMove(o, simOwner, simArmy, siege, bestCity, false);
  }
}

function attackEnemy(o, simOwner, simArmy, moves) {
  var candidates = [];
  for (var y = 0; y < G.H; y++) {
    for (var x = 0; x < G.W; x++) {
      var owner = simOwner[y][x];
      if (owner < 0 || owner === G.myId || sameTeam(owner)) continue;
      var def = simArmy[y][x];
      if (def < 0) continue;
      var from = null;
      for (var i = 0; i < 4; i++) {
        var sx = x + DIRS[i][0], sy = y + DIRS[i][1];
        if (inBounds(sx, sy) && simOwner[sy][sx] === G.myId && simArmy[sy][sx] - 1 > def) {
          if (!from || simArmy[sy][sx] > simArmy[from.y][from.x]) from = { x: sx, y: sy };
        }
      }
      if (!from) continue;
      var terr = G.terrain[y][x];
      var score = 50;
      if (terr === 2) score += 5000;
      for (var gi = 0; gi < G.enemyGenerals.length; gi++) {
        var g = G.enemyGenerals[gi];
        var d = Math.abs(g.x - x) + Math.abs(g.y - y);
        if (d <= 2) { score += 2000; break; }
      }
      score += objectiveBias(x, y);
      if (score >= 2000) {
        candidates.push({ x: x, y: y, from: from, score: score });
      }
    }
  }
  candidates.sort(function (a, b) { return b.score - a.score; });
  for (var i = 0; i < candidates.length; i++) {
    if (moves.length >= 4) break;
    var c = candidates[i];
    if (simOwner[c.y][c.x] < 0 || simOwner[c.y][c.x] === G.myId || sameTeam(simOwner[c.y][c.x])) continue;
    if (simArmy[c.from.y][c.from.x] - 1 <= simArmy[c.y][c.x]) continue;
    moves.push({ from: c.from, dir: dirTo(c.from, { x: c.x, y: c.y }), half: false });
    applyMove(o, simOwner, simArmy, c.from, { x: c.x, y: c.y }, false);
  }
}

function marchToObjective(o, simOwner, simArmy, moves) {
  if (moves.length >= 4) return;

  var bestSrc = null, bestScore = -Infinity;
  var y, x;
  for (y = 0; y < G.H; y++) {
    for (x = 0; x < G.W; x++) {
      if (simOwner[y][x] !== G.myId || simArmy[y][x] < 15) continue;
      var d = G.objDist[y * G.W + x];
      if (d === Infinity || d < 2) continue;
      var score = simArmy[y][x] - d * 3;
      if (score > bestScore) {
        bestScore = score;
        bestSrc = { x: x, y: y };
      }
    }
  }
  if (!bestSrc) return;

  var bestObj = null, bestD = Infinity;
  for (y = 0; y < G.H; y++) {
    for (x = 0; x < G.W; x++) {
      if (G.terrain[y][x] === 2 && o.owner[y][x] === -1) {
        var d = Math.abs(bestSrc.x - x) + Math.abs(bestSrc.y - y);
        if (d < bestD) { bestD = d; bestObj = { x: x, y: y, isGeneral: false }; }
      }
    }
  }
  for (var gi = 0; gi < G.enemyGenerals.length; gi++) {
    var eg = G.enemyGenerals[gi];
    if (o.terrain[eg.y][eg.x] >= 0 && o.terrain[eg.y][eg.x] !== 3) continue;
    if (simOwner[eg.y][eg.x] === G.myId || (simOwner[eg.y][eg.x] >= 0 && sameTeam(simOwner[eg.y][eg.x]))) continue;
    var d2 = Math.abs(bestSrc.x - eg.x) + Math.abs(bestSrc.y - eg.y);
    if (d2 < bestD) { bestD = d2; bestObj = { x: eg.x, y: eg.y, isGeneral: true }; }
  }
  if (!bestObj || bestD < 2) return;

  var cx = bestSrc.x, cy = bestSrc.y;
  var moved = false;
  for (var step = 0; step < 3 && moves.length < 4; step++) {
    var n = simArmy[cy][cx];
    if (n < 3) break;
    var bestDir = null;
    var bestD2 = Infinity;
    var bestTx = 0, bestTy = 0;
    for (var i = 0; i < 4; i++) {
      var tx = cx + DIRS[i][0], ty = cy + DIRS[i][1];
      if (!inBounds(tx, ty) || G.terrain[ty][tx] === 1) continue;
      var owner = simOwner[ty][tx];
      var ok = false;
      if (owner === G.myId || owner === -1) ok = true;
      else if (owner >= 0 && !sameTeam(owner) && n - 1 > simArmy[ty][tx]) ok = true;
      if (!ok) continue;
      var d = Math.abs(bestObj.x - tx) + Math.abs(bestObj.y - ty);
      if (d < bestD2) {
        bestD2 = d;
        bestDir = DIRS[i][2];
        bestTx = tx;
        bestTy = ty;
      }
    }
    if (!bestDir) break;
    if (bestTx === bestObj.x && bestTy === bestObj.y) break;
    moves.push({ from: { x: cx, y: cy }, dir: bestDir, half: false });
    applyMove(o, simOwner, simArmy, { x: cx, y: cy }, { x: bestTx, y: bestTy }, false);
    cx = bestTx;
    cy = bestTy;
    moved = true;
  }
  if (moved) G.marchPos = { x: cx, y: cy };
}

function buildChain(o, simOwner, simArmy, startX, startY, budget) {
  var localArmy = {};
  var localOwner = {};

  function getArmy(x, y) {
    var i = y * G.W + x;
    var v = localArmy[i];
    return v !== undefined ? v : simArmy[y][x];
  }
  function setArmy(x, y, v) { localArmy[y * G.W + x] = v; }
  function getOwner(x, y) {
    var i = y * G.W + x;
    var v = localOwner[i];
    return v !== undefined ? v : simOwner[y][x];
  }
  function setOwner(x, y, v) { localOwner[y * G.W + x] = v; }

  var moves = [];
  var totalScore = 0;
  var cx = startX, cy = startY;

  for (var step = 0; step < budget; step++) {
    var n = getArmy(cx, cy);
    if (n < 2) break;
    var bestDir = null;
    var bestScore = -Infinity;
    var bestK = 0;
    var bestHalf = true;
    var bestTx = 0, bestTy = 0;

    for (var i = 0; i < 4; i++) {
      var tx = cx + DIRS[i][0], ty = cy + DIRS[i][1];
      if (!inBounds(tx, ty)) continue;
      if (G.terrain[ty][tx] === 1) continue;
      var owner = getOwner(tx, ty);
      if (owner === G.myId) continue;
      if (owner >= 0 && sameTeam(owner)) continue;
      var def = getArmy(tx, ty);
      var terr = G.terrain[ty][tx];
      var isGeneral = terr === 3 && !(tx === G.myGeneral.x && ty === G.myGeneral.y);
      var isCity = terr === 2;
      var isEnemy = owner >= 0;
      var half = true;
      var k = Math.floor(n / 2);
      var score = -Infinity;

      if (isEnemy) {
        k = n - 1;
        half = false;
        if (k > def) {
          score = (isGeneral ? 100000 : (isCity ? 6000 : 500)) + (k - def) * 2 + objectiveBias(tx, ty);
        }
      } else if (isCity) {
        k = n - 1;
        half = false;
        if (k > def) {
          score = 8000 + (k - def) * 2;
        }
      } else {
        half = true;
        k = Math.floor(n / 2);
        if (k >= 1) {
          score = expansionScore(tx, ty);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestDir = DIRS[i][2];
        bestK = k;
        bestHalf = half;
        bestTx = tx;
        bestTy = ty;
      }
    }

    if (!bestDir) break;

    moves.push({ from: { x: cx, y: cy }, dir: bestDir, half: bestHalf });
    totalScore += bestScore;

    setArmy(cx, cy, getArmy(cx, cy) - bestK);
    var toOwner = getOwner(bestTx, bestTy);
    var toDef = getArmy(bestTx, bestTy);
    if (toOwner === G.myId || sameTeam(toOwner)) {
      setArmy(bestTx, bestTy, toDef + bestK);
    } else if (bestK > toDef) {
      setOwner(bestTx, bestTy, G.myId);
      setArmy(bestTx, bestTy, bestK - toDef);
    } else {
      setArmy(bestTx, bestTy, toDef - bestK);
    }

    cx = bestTx;
    cy = bestTy;
  }

  return { moves: moves, score: totalScore };
}

function quickScore(o, simOwner, simArmy, x, y) {
  var n = simArmy[y][x];
  if (n < 2) return -Infinity;
  var best = -Infinity;
  for (var i = 0; i < 4; i++) {
    var tx = x + DIRS[i][0], ty = y + DIRS[i][1];
    if (!inBounds(tx, ty) || G.terrain[ty][tx] === 1) continue;
    var owner = simOwner[ty][tx];
    if (owner === G.myId || (owner >= 0 && sameTeam(owner))) continue;
    var def = simArmy[ty][tx];
    var terr = G.terrain[ty][tx];
    var isGeneral = terr === 3 && !(tx === G.myGeneral.x && ty === G.myGeneral.y);
    var isCity = terr === 2;
    var isEnemy = owner >= 0;
    var score = -Infinity;
    if (isEnemy) {
      var k = n - 1;
      if (k > def) score = (isGeneral ? 100000 : (isCity ? 6000 : 500)) + (k - def) * 2 + objectiveBias(tx, ty);
    } else if (isCity) {
      var k2 = n - 1;
      if (k2 > def) score = 8000 + (k2 - def) * 2;
    } else {
      var k3 = Math.floor(n / 2);
      if (k3 >= 1) score = expansionScore(tx, ty);
    }
    if (score > best) best = score;
  }
  return best;
}

function hasNonOwnedNeighbor(simOwner, x, y) {
  for (var i = 0; i < 4; i++) {
    var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
    if (inBounds(nx, ny) && G.terrain[ny][nx] !== 1) {
      var ow = simOwner[ny][nx];
      if (ow !== G.myId && !(ow >= 0 && sameTeam(ow))) return true;
    }
  }
  return false;
}

function expand(o, simOwner, simArmy, moves) {
  var candidates = [];
  for (var y = 0; y < G.H; y++) {
    for (var x = 0; x < G.W; x++) {
      if (simOwner[y][x] === G.myId && simArmy[y][x] >= 2) {
        if (G.marchPos && G.marchPos.x === x && G.marchPos.y === y) continue;
        if (!hasNonOwnedNeighbor(simOwner, x, y)) continue;
        var qs = quickScore(o, simOwner, simArmy, x, y);
        if (qs > -Infinity) candidates.push({ x: x, y: y, score: qs });
      }
    }
  }
  candidates.sort(function (a, b) { return b.score - a.score; });
  if (candidates.length > 32) candidates.length = 32;

  while (moves.length < 4) {
    var budget = 4 - moves.length;
    var bestChain = null;
    var bestScore = -Infinity;
    for (var ci = 0; ci < candidates.length; ci++) {
      var c = candidates[ci];
      if (simOwner[c.y][c.x] !== G.myId || simArmy[c.y][c.x] < 2) continue;
      if (G.marchPos && G.marchPos.x === c.x && G.marchPos.y === c.y) continue;
      if (!hasNonOwnedNeighbor(simOwner, c.x, c.y)) continue;
      var chain = buildChain(o, simOwner, simArmy, c.x, c.y, budget);
      if (chain.moves.length && chain.score > bestScore) {
        bestScore = chain.score;
        bestChain = chain;
      }
    }
    if (!bestChain) break;
    for (var i = 0; i < bestChain.moves.length && moves.length < 4; i++) {
      var m = bestChain.moves[i];
      moves.push(m);
      var to = { x: m.from.x, y: m.from.y };
      if (m.dir === 'up') to.y--;
      else if (m.dir === 'right') to.x++;
      else if (m.dir === 'down') to.y++;
      else to.x--;
      applyMove(o, simOwner, simArmy, m.from, to, m.half);
      if (simOwner[to.y][to.x] === G.myId && simArmy[to.y][to.x] >= 2) {
        if (!(G.marchPos && G.marchPos.x === to.x && G.marchPos.y === to.y)) {
          if (hasNonOwnedNeighbor(simOwner, to.x, to.y)) {
            var qs2 = quickScore(o, simOwner, simArmy, to.x, to.y);
            if (qs2 > -Infinity) candidates.push({ x: to.x, y: to.y, score: qs2 });
          }
        }
      }
    }
    candidates.sort(function (a, b) { return b.score - a.score; });
    if (candidates.length > 32) candidates.length = 32;
  }
}

function decide(o) {
  if (!G) initGame(o);
  updateState(o);

  var simOwner = cloneGrid(o.owner);
  var simArmy = cloneGrid(o.army);

  var moves = [];

  defendGeneral(o, simOwner, simArmy, moves);
  if (moves.length < 4) killGeneral(o, simOwner, simArmy, moves);
  if (moves.length < 4) captureCity(o, simOwner, simArmy, moves);
  if (moves.length < 4) attackEnemy(o, simOwner, simArmy, moves);
  if (moves.length < 4) marchToObjective(o, simOwner, simArmy, moves);
  if (moves.length < 4) expand(o, simOwner, simArmy, moves);

  return { moves: moves, memory: null };
}
