'use strict';
/* ============================================================
 * hunter.js — 迷宫竞速「追逐策略」
 * 控制本回合所有世界中的全部追逐者。
 * 纯确定性算法；无 import/export、无第三方依赖。
 * ============================================================ */

var INF = 0xffffffff;
var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

function hashStr(s) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function buildLookups(o) {
  var n = o.width * o.height;
  var gateIdx = new Int32Array(n);
  var trapIdx = new Int32Array(n);
  gateIdx.fill(-1);
  trapIdx.fill(-1);
  for (var i = 0; i < o.gates.length; i++) {
    var g = o.gates[i];
    gateIdx[g.y * o.width + g.x] = i;
  }
  for (var j = 0; j < o.traps.length; j++) {
    var t = o.traps[j];
    trapIdx[t.y * o.width + t.x] = j;
  }
  return { gateIdx: gateIdx, trapIdx: trapIdx };
}

function gateClosed(g, tick) {
  return ((tick + g.phase) % g.period) < g.on;
}

function trapActive(t, tick) {
  return ((tick + t.phase) % t.period) < t.on;
}

/* BFS 距离图。tick 为 null 时闸门全部视为可通过；
 * tick 为数字时，该 tick 关闭的闸门视为墙。 */
function bfsDist(o, look, sx, sy, tick) {
  var w = o.width, h = o.height, n = w * h;
  var dist = new Uint32Array(n);
  dist.fill(INF);
  if (sx < 0 || sx >= w || sy < 0 || sy >= h) return dist;
  if (o.grid[sy][sx] !== 0) return dist;
  var queue = new Int32Array(n);
  var head = 0, tail = 0;
  dist[sy * w + sx] = 0;
  queue[tail++] = sx;
  queue[tail++] = sy;
  var grid = o.grid;
  var gateIdx = look.gateIdx;
  var gates = o.gates;
  while (head < tail) {
    var x = queue[head++], y = queue[head++];
    var d = dist[y * w + x] + 1;
    for (var i = 0; i < 4; i++) {
      var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      var k = ny * w + nx;
      if (dist[k] !== INF || grid[ny][nx] !== 0) continue;
      var ok = true;
      if (tick !== null) {
        var gi = gateIdx[k];
        if (gi >= 0 && gateClosed(gates[gi], tick)) ok = false;
      }
      if (ok) {
        dist[k] = d;
        queue[tail++] = nx;
        queue[tail++] = ny;
      }
    }
  }
  return dist;
}

/* 从 (sx,sy) 到 target 的 BFS 路径（不含起点，含终点）；tick 用于闸门 */
function bfsPath(o, look, sx, sy, target, tick) {
  var w = o.width, h = o.height, n = w * h;
  var startK = sy * w + sx;
  var targetK = target.y * w + target.x;
  var parent = new Int32Array(n);
  parent.fill(-2);
  var queue = new Int32Array(n);
  var head = 0, tail = 0;
  parent[startK] = -1;
  queue[tail++] = sx;
  queue[tail++] = sy;
  var grid = o.grid;
  var gateIdx = look.gateIdx;
  var gates = o.gates;
  while (head < tail && parent[targetK] === -2) {
    var x = queue[head++], y = queue[head++];
    var k = y * w + x;
    for (var i = 0; i < 4; i++) {
      var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      var nk = ny * w + nx;
      if (parent[nk] !== -2) continue;
      if (grid[ny][nx] !== 0) continue;
      if (tick !== null) {
        var gi = gateIdx[nk];
        if (gi >= 0 && gateClosed(gates[gi], tick)) continue;
      }
      parent[nk] = k;
      queue[tail++] = nx;
      queue[tail++] = ny;
    }
  }
  if (parent[targetK] === -2) return [];
  var path = [];
  var cur = targetK;
  while (cur !== startK) {
    path.push({ x: cur % w, y: Math.floor(cur / w) });
    cur = parent[cur];
  }
  path.reverse();
  return path;
}

/* 预测玩家下一步会走到哪。
 * 模拟玩家“朝目标走，并躲避机关和猎人”的贪心选择。 */
function predictPlayerNext(o, look, goal) {
  if (!goal) return { x: o.player.x, y: o.player.y };
  var w = o.width;
  var dist = bfsDist(o, look, goal.x, goal.y, o.tick);
  var hunterMaps = [];
  for (var i = 0; i < o.hunters.length; i++) {
    hunterMaps.push(bfsDist(o, look, o.hunters[i].x, o.hunters[i].y, o.tick));
  }
  var hunterTick = ((o.tick + 1) % o.hunterEvery === 0);
  var px = o.player.x, py = o.player.y;
  var moves = [['up', 0, -1], ['right', 1, 0], ['down', 0, 1], ['left', -1, 0], ['wait', 0, 0]];
  var bestAction = 'wait', bestScore = Infinity;
  for (var m = 0; m < 5; m++) {
    var action = moves[m][0], dx = moves[m][1], dy = moves[m][2];
    var nx = px + dx, ny = py + dy;
    if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
    if (m < 4) {
      if (o.grid[ny][nx] !== 0) continue;
      var gi = look.gateIdx[ny * w + nx];
      if (gi >= 0 && gateClosed(o.gates[gi], o.tick)) continue;
    }
    var score = dist[ny * w + nx];
    if (score === INF) continue;
    // 玩家会避免踩到本 tick 激活的机关
    var ti = look.trapIdx[ny * w + nx];
    if (ti >= 0 && trapActive(o.traps[ti], o.tick)) score += 30;
    // 玩家会避免被猎人抓到
    for (var h = 0; h < hunterMaps.length; h++) {
      var d = hunterMaps[h][ny * w + nx];
      if (d !== INF) {
        if (hunterTick && d <= 1) score += 100;
        else if (d <= 2) score += 8;
      }
    }
    score += (hashStr(o.seed + '|' + o.tick + '|pred|' + action) % 1000) / 1000000;
    if (score < bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }
  var bx = px, by = py;
  if (bestAction === 'up') by = py - 1;
  else if (bestAction === 'down') by = py + 1;
  else if (bestAction === 'left') bx = px - 1;
  else if (bestAction === 'right') bx = px + 1;
  return { x: bx, y: by };
}

/* 让追逐者朝 target 走一步（BFS 最短路，当前 tick 关闭的闸门视为墙） */
function stepToward(o, look, x, y, target) {
  var w = o.width;
  var dist = bfsDist(o, look, target.x, target.y, o.tick);
  var k = y * w + x;
  if (dist[k] === INF) return 'wait';
  var moves = [['up', 0, -1], ['right', 1, 0], ['down', 0, 1], ['left', -1, 0]];
  var bestAction = 'wait';
  var bestD = dist[k];
  for (var i = 0; i < 4; i++) {
    var action = moves[i][0], dx = moves[i][1], dy = moves[i][2];
    var nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
    if (o.grid[ny][nx] !== 0) continue;
    var gi = look.gateIdx[ny * w + nx];
    if (gi >= 0 && gateClosed(o.gates[gi], o.tick)) continue;
    var d = dist[ny * w + nx];
    if (d < bestD) {
      bestD = d;
      bestAction = action;
    }
  }
  return bestAction;
}

/* 主入口：仅在 (tick+1) % hunterEvery === 0 时被调用。
 * 为所有追逐者一次性返回动作。 */
function decide(o) {
  var look = buildLookups(o);
  var goal = o.player.hasKey ? o.exit : o.key;
  var pred = predictPlayerNext(o, look, goal);

  // 玩家到目标的 BFS 路径，用于设置前方拦截点
  var playerPath = [];
  if (goal) {
    playerPath = bfsPath(o, look, o.player.x, o.player.y, goal, o.tick);
  }

  var w = o.width;
  var E = o.hunterEvery;

  // 玩家当前位置距离图（用于判断“贴身追逐”）
  var distFromPlayer = bfsDist(o, look, o.player.x, o.player.y, o.tick);
  // 预测点距离图（用于排序：离预测点最近的猎人主追）
  var distFromPred = bfsDist(o, look, pred.x, pred.y, o.tick);

  var order = [];
  for (var i = 0; i < o.hunters.length; i++) {
    var h = o.hunters[i];
    var d = distFromPred[h.y * w + h.x];
    if (d === INF) d = 999999;
    order.push({ idx: i, d: d });
  }
  order.sort(function (a, b) { return a.d - b.d; });

  var actions = [];
  for (var rank = 0; rank < o.hunters.length; rank++) {
    var info = order[rank];
    var h = o.hunters[info.idx];
    var target;

    if (rank === 0) {
      var dToPred = info.d;
      var dToPlayer = distFromPlayer[h.y * w + h.x];
      if (dToPred <= 1 || dToPlayer <= 3) {
        // 贴脸时直接扑向玩家预测的下一步位置
        target = pred;
      } else if (playerPath.length > 0) {
        // 拦截玩家在下一次猎人移动时到达的位置
        var idx0 = Math.min(E - 1, playerPath.length - 1);
        target = playerPath[idx0];
      } else {
        target = pred;
      }
    } else {
      if (playerPath.length > 0) {
        // 更远的猎人负责更前方的拦截点，形成包围
        var idxr = Math.min((rank + 1) * E - 1, playerPath.length - 1);
        target = playerPath[idxr];
      } else {
        target = pred;
      }
    }

    var action = stepToward(o, look, h.x, h.y, target);
    actions.push({ id: h.id, action: action });
  }

  return { actions: actions, memory: null };
}