'use strict';
/* ============================================================
 * strategy.js — 迷宫竞速「走迷宫策略」
 * 纯确定性算法；无 import/export、无第三方依赖。
 * ============================================================ */

var INF = 0xffffffff;
var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
var MOVES = [
  ['up', 0, -1],
  ['right', 1, 0],
  ['down', 0, 1],
  ['left', -1, 0],
  ['wait', 0, 0]
];

/* 调参常量 */
var TRAP_PENALTY = 25;        // 路径规划中踩到激活机关的代价
var HUNTER_PENALTY = 4;       // 每级“可被追逐者拦截”风险的代价
var HUNTER_PENALTY_CAP = 24;  // 风险代价上限
var COIN_DETOUR_MAX = 8;      // 收集晶片允许的最大绕路步数
var MAX_PLAN_STEPS = 220;     // 单次规划的最大步数（规划视界）
var REPLAN_INTERVAL = 10;     // 定期重规划间隔
var PLAN_BUDGET = 45000;      // A* 扩展节点预算
var STUCK_LIMIT = 10;         // 卡死安全网触发阈值

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

function gateAtIdx(o, look, x, y) {
  var gi = look.gateIdx[y * o.width + x];
  return gi >= 0 ? o.gates[gi] : null;
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

/* 从 (x,y) 走到 (nx,ny) 的方向 */
function dirTo(x, y, nx, ny) {
  if (nx === x + 1) return 'right';
  if (nx === x - 1) return 'left';
  if (ny === y + 1) return 'down';
  if (ny === y - 1) return 'up';
  return 'wait';
}

function isValidStep(o, look, x, y, nx, ny, tick) {
  if (nx === x && ny === y) return true;
  if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) return false;
  var dx = nx - x, dy = ny - y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
  if (o.grid[ny][nx] !== 0) return false;
  var g = gateAtIdx(o, look, nx, ny);
  if (g && gateClosed(g, tick)) return false;
  return true;
}

/* 选择当前目标：没钥匙→钥匙；有钥匙→出口；
 * 拿钥匙后若某晶片的绕路很小，则先顺路收集（提交后保持目标稳定）。 */
function chooseTarget(o, look, m) {
  if (m && m.tt === 'coin' && m.tx >= 0 && m.ty >= 0) {
    for (var c = 0; c < o.coins.length; c++) {
      if (o.coins[c].x === m.tx && o.coins[c].y === m.ty) {
        return { x: m.tx, y: m.ty, type: 'coin' };
      }
    }
  }
  var main = o.player.hasKey ? o.exit : o.key;
  if (!main) return null;
  if (o.player.hasKey && o.coins.length > 0) {
    var w = o.width;
    var dFrom = bfsDist(o, look, o.player.x, o.player.y, null);
    var dTo = bfsDist(o, look, o.exit.x, o.exit.y, null);
    var direct = dFrom[o.exit.y * w + o.exit.x];
    if (direct !== INF) {
      var bestCoin = null, bestDetour = Infinity;
      for (var i = 0; i < o.coins.length; i++) {
        var coin = o.coins[i];
        var d1 = dFrom[coin.y * w + coin.x];
        var d2 = dTo[coin.y * w + coin.x];
        if (d1 === INF || d2 === INF) continue;
        var detour = d1 + d2 - direct;
        if (detour < bestDetour) {
          bestDetour = detour;
          bestCoin = coin;
        }
      }
      if (bestCoin && bestDetour <= COIN_DETOUR_MAX) {
        return { x: bestCoin.x, y: bestCoin.y, type: 'coin' };
      }
    }
  }
  return { x: main.x, y: main.y, type: o.player.hasKey ? 'exit' : 'key' };
}

/* 猎人风险：在 time 时刻，追逐者最多能移动多少次到达 (x,y)。
 * 用“从追逐者当前位置出发、闸门全开”的 BFS 距离做可达性上界。 */
function hunterDanger(o, hunterDists, x, y, startTick, time, hunterEvery) {
  var moves = Math.floor((time + 1) / hunterEvery) - Math.floor((startTick + 1) / hunterEvery);
  if (moves <= 0) return 0;
  var pen = 0;
  var idx = y * o.width + x;
  for (var i = 0; i < hunterDists.length; i++) {
    var d = hunterDists[i][idx];
    if (d !== INF && d <= moves) {
      pen += (moves - d + 1) * HUNTER_PENALTY;
      if (pen >= HUNTER_PENALTY_CAP) return HUNTER_PENALTY_CAP;
    }
  }
  return pen;
}

/* A* 路径规划（时间依赖：闸门/机关状态随 tick 变化）。
 * 状态为 (格子, 已走步数)，代价 = 步数 + 机关惩罚 + 猎人风险。
 * 若预算内到不了终点，则返回“最接近目标”的可行路径前缀。 */
function planPath(o, look, target, startTick) {
  var w = o.width, h = o.height, n = w * h;
  var sx = o.player.x, sy = o.player.y;
  var hDist = bfsDist(o, look, target.x, target.y, null);
  var startK = sy * w + sx;
  if (hDist[startK] === INF) return null;

  var maxS = Math.min(MAX_PLAN_STEPS, hDist[startK] + 60);
  if (maxS < 1) return null;
  var maxS1 = maxS + 1;

  var bestCost = new Float64Array(n * maxS1);
  bestCost.fill(Infinity);

  var hunterDists = [];
  for (var i = 0; i < o.hunters.length; i++) {
    hunterDists.push(bfsDist(o, look, o.hunters[i].x, o.hunters[i].y, null));
  }

  var nodeX = [], nodeY = [], nodeSteps = [], nodeCost = [], nodeF = [], nodeParent = [];
  var heap = [];

  function heapPush(idx) {
    var f = nodeF[idx];
    var i = heap.length;
    heap.push(idx);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (nodeF[heap[p]] <= f) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = idx;
  }

  function heapPop() {
    var top = heap[0];
    var last = heap.pop();
    if (heap.length > 0) {
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = 2 * i + 2;
        if (l >= heap.length) break;
        var smallest = l;
        if (r < heap.length && nodeF[heap[r]] < nodeF[heap[l]]) smallest = r;
        if (nodeF[heap[smallest]] >= nodeF[last]) break;
        heap[i] = heap[smallest];
        i = smallest;
      }
      heap[i] = last;
    }
    return top;
  }

  function pushNode(x, y, steps, cost, parent) {
    var idx = nodeX.length;
    nodeX.push(x);
    nodeY.push(y);
    nodeSteps.push(steps);
    nodeCost.push(cost);
    nodeParent.push(parent);
    nodeF.push(cost + hDist[y * w + x]);
    heapPush(idx);
  }

  pushNode(sx, sy, 0, 0, -1);
  bestCost[startK * maxS1 + 0] = 0;

  var found = -1;
  var bestNode = -1;
  var bestH = hDist[startK];
  var hunterEvery = o.hunterEvery;
  var budget = PLAN_BUDGET;

  while (heap.length > 0 && budget-- > 0) {
    var idx = heapPop();
    var x = nodeX[idx], y = nodeY[idx], steps = nodeSteps[idx], cost = nodeCost[idx];
    var k = y * w + x;
    var stateKey = k * maxS1 + steps;
    if (cost > bestCost[stateKey]) continue;

    var hval = hDist[k];
    if (hval < bestH) {
      bestH = hval;
      bestNode = idx;
    }

    if (x === target.x && y === target.y) {
      found = idx;
      break;
    }
    if (steps >= maxS) continue;

    var time = startTick + steps; // 下一步移动发生并结算的 tick

    for (var mi = 0; mi < 5; mi++) {
      var dx, dy;
      if (mi < 4) { dx = DIRS[mi][0]; dy = DIRS[mi][1]; }
      else { dx = 0; dy = 0; }
      var nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (mi < 4) {
        if (o.grid[ny][nx] !== 0) continue;
        var gi = look.gateIdx[ny * w + nx];
        if (gi >= 0 && gateClosed(o.gates[gi], time)) continue;
      }
      var extra = 1;
      // 到达出口即胜利：出口格不叠加机关/猎人惩罚
      var isExitWin = (target.type === 'exit' && nx === target.x && ny === target.y);
      if (!isExitWin) {
        var ti = look.trapIdx[ny * w + nx];
        if (ti >= 0 && trapActive(o.traps[ti], time)) extra += TRAP_PENALTY;
        extra += hunterDanger(o, hunterDists, nx, ny, startTick, time, hunterEvery);
      }
      var ns = steps + 1;
      var nk = ny * w + nx;
      var nState = nk * maxS1 + ns;
      var nc = cost + extra;
      if (nc < bestCost[nState]) {
        bestCost[nState] = nc;
        pushNode(nx, ny, ns, nc, idx);
      }
    }
  }

  var endNode = found >= 0 ? found : bestNode;
  if (endNode < 0) return null;
  var path = [];
  var cur = endNode;
  while (cur >= 0) {
    path.push({ x: nodeX[cur], y: nodeY[cur] });
    cur = nodeParent[cur];
  }
  path.reverse();
  return path.slice(1);
}

/* 若玩家走到 (x,y)，本 tick 结束后离最近追逐者的“有效距离”。
 * 追逐者本 tick 会移动时（猎人 tick）其有效距离减 1。 */
function projectedMinHunterDist(o, look, hunterMaps, x, y) {
  var hunterTick = ((o.tick + 1) % o.hunterEvery === 0);
  var minD = Infinity;
  var idx = y * o.width + x;
  for (var i = 0; i < hunterMaps.length; i++) {
    var d = hunterMaps[i][idx];
    if (d === INF) d = 99;
    if (hunterTick) d -= 1;
    if (d < minD) minD = d;
  }
  return minD;
}

/* 紧急躲避：在危险时选择让玩家离猎人最远的合法移动 */
function chooseEvade(o, look, hunterMaps, target) {
  var w = o.width;
  var distToTarget = null;
  if (target) distToTarget = bfsDist(o, look, target.x, target.y, null);
  var bestAction = 'wait', bestScore = -Infinity;
  for (var i = 0; i < 5; i++) {
    var action = MOVES[i][0], dx = MOVES[i][1], dy = MOVES[i][2];
    var nx = o.player.x + dx, ny = o.player.y + dy;
    if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
    if (dx !== 0 || dy !== 0) {
      if (o.grid[ny][nx] !== 0) continue;
      var g = gateAtIdx(o, look, nx, ny);
      if (g && gateClosed(g, o.tick)) continue;
    }
    var score = 0;
    // 有钥匙且一步到出口：直接赢，给予巨大奖励
    if (o.player.hasKey && nx === o.exit.x && ny === o.exit.y) {
      score += 1000;
    } else {
      var t = look.trapIdx[ny * w + nx];
      if (t >= 0 && trapActive(o.traps[t], o.tick)) score -= 30;
      var minD = projectedMinHunterDist(o, look, hunterMaps, nx, ny);
      score += Math.min(minD, 6) * 10;
      if (distToTarget) {
        var d = distToTarget[ny * w + nx];
        if (d !== INF) score -= d * 2;
      }
    }
    score += (hashStr(o.seed + '|' + o.tick + '|ev|' + action) % 1000) / 1000000;
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }
  return bestAction;
}

/* 贪心回退：没有完整路径时，朝目标 BFS 距离最小的方向走 */
function greedyMove(o, look, target, hunterMaps) {
  var w = o.width;
  var dist = bfsDist(o, look, target.x, target.y, o.tick);
  var bestAction = 'wait', bestScore = Infinity;
  var bestX = o.player.x, bestY = o.player.y;
  for (var i = 0; i < 5; i++) {
    var action = MOVES[i][0], dx = MOVES[i][1], dy = MOVES[i][2];
    var nx = o.player.x + dx, ny = o.player.y + dy;
    if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
    if (dx !== 0 || dy !== 0) {
      if (o.grid[ny][nx] !== 0) continue;
      var g = gateAtIdx(o, look, nx, ny);
      if (g && gateClosed(g, o.tick)) continue;
    }
    var score;
    var isExitWin = (o.player.hasKey && nx === o.exit.x && ny === o.exit.y);
    if (isExitWin) {
      score = -1000;
    } else {
      var d = dist[ny * w + nx];
      if (d === INF) continue;
      score = d;
      var t = look.trapIdx[ny * w + nx];
      if (t >= 0 && trapActive(o.traps[t], o.tick)) score += 30;
      var proj = projectedMinHunterDist(o, look, hunterMaps, nx, ny);
      if (proj <= 1) score += 50;
    }
    score += (hashStr(o.seed + '|' + o.tick + '|gr|' + action) % 1000) / 1000000;
    if (score < bestScore) {
      bestScore = score;
      bestAction = action;
      bestX = nx;
      bestY = ny;
    }
  }
  return { action: bestAction, x: bestX, y: bestY };
}

/* 卡死时的确定性强制移动 */
function forcedMove(o, look) {
  var h = hashStr(o.seed + '|' + o.tick + '|force');
  for (var i = 0; i < 5; i++) {
    var idx = (h + i) % 5;
    var action = MOVES[idx][0], dx = MOVES[idx][1], dy = MOVES[idx][2];
    var nx = o.player.x + dx, ny = o.player.y + dy;
    if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
    if (dx !== 0 || dy !== 0) {
      if (o.grid[ny][nx] !== 0) continue;
      var g = gateAtIdx(o, look, nx, ny);
      if (g && gateClosed(g, o.tick)) continue;
    }
    return { action: action, x: nx, y: ny };
  }
  return null;
}

function normalizeMem(mem) {
  var m = {};
  if (mem && typeof mem === 'object') {
    if (Array.isArray(mem.path)) m.path = mem.path.slice();
    if (typeof mem.tx === 'number') m.tx = mem.tx;
    if (typeof mem.ty === 'number') m.ty = mem.ty;
    if (typeof mem.tt === 'string') m.tt = mem.tt;
    if (typeof mem.planTick === 'number') m.planTick = mem.planTick;
    if (typeof mem.lastX === 'number') m.lastX = mem.lastX;
    if (typeof mem.lastY === 'number') m.lastY = mem.lastY;
    if (typeof mem.stuck === 'number') m.stuck = mem.stuck;
  }
  if (!Array.isArray(m.path)) m.path = [];
  if (typeof m.tx !== 'number') m.tx = -1;
  if (typeof m.ty !== 'number') m.ty = -1;
  if (typeof m.tt !== 'string') m.tt = '';
  if (typeof m.planTick !== 'number') m.planTick = -1;
  if (typeof m.lastX !== 'number') m.lastX = -1;
  if (typeof m.lastY !== 'number') m.lastY = -1;
  if (typeof m.stuck !== 'number') m.stuck = 0;
  return m;
}

/* 主入口 */
function decide(o) {
  var look = buildLookups(o);
  var m = normalizeMem(o.memory);

  // 卡死检测
  if (o.player.x === m.lastX && o.player.y === m.lastY) {
    m.stuck++;
  } else {
    m.stuck = 0;
    m.lastX = o.player.x;
    m.lastY = o.player.y;
  }

  var target = chooseTarget(o, look, m);

  // 追逐者距离图（当前 tick 关闭的闸门会阻挡追逐者本 tick 移动）
  var hunterMaps = [];
  for (var i = 0; i < o.hunters.length; i++) {
    hunterMaps.push(bfsDist(o, look, o.hunters[i].x, o.hunters[i].y, o.tick));
  }

  var action = 'wait';
  var nextX = o.player.x, nextY = o.player.y;
  var followedPath = false;

  // 缓存路径是否仍可用
  var needPlan = true;
  if (m.path.length >= 2 && target && m.tx === target.x && m.ty === target.y) {
    var px0 = m.path[0], py0 = m.path[1];
    if (isValidStep(o, look, o.player.x, o.player.y, px0, py0, o.tick)) {
      var proj0 = projectedMinHunterDist(o, look, hunterMaps, px0, py0);
      if (proj0 >= 1 || o.tick < o.player.invulnerableUntil) {
        needPlan = false;
      }
    }
  }
  // 定期重规划，让路径适应追逐者位置变化
  if (!needPlan && m.planTick >= 0 && o.tick - m.planTick >= REPLAN_INTERVAL) {
    needPlan = true;
  }

  if (!needPlan) {
    nextX = m.path[0];
    nextY = m.path[1];
    action = dirTo(o.player.x, o.player.y, nextX, nextY);
    followedPath = true;
  } else if (target) {
    var path = planPath(o, look, target, o.tick);
    if (path && path.length > 0) {
      m.path = [];
      for (var j = 0; j < path.length; j++) {
        m.path.push(path[j].x, path[j].y);
      }
      m.tx = target.x;
      m.ty = target.y;
      m.tt = target.type;
      m.planTick = o.tick;
      nextX = path[0].x;
      nextY = path[0].y;
      action = dirTo(o.player.x, o.player.y, nextX, nextY);
      followedPath = true;
    } else {
      var gm = greedyMove(o, look, target, hunterMaps);
      action = gm.action;
      nextX = gm.x;
      nextY = gm.y;
      m.path = [];
      m.tx = -1;
      m.ty = -1;
      m.planTick = o.tick;
    }
  } else {
    m.path = [];
    m.tx = -1;
    m.ty = -1;
  }

  // 猎人安全覆盖（无敌期间不回避，利用无敌窗口穿过；一步到出口则直接赢）
  var exitWin = (o.player.hasKey && nextX === o.exit.x && nextY === o.exit.y);
  if (!exitWin && o.tick >= o.player.invulnerableUntil) {
    var proj = projectedMinHunterDist(o, look, hunterMaps, nextX, nextY);
    if (proj <= 1) {
      var ev = chooseEvade(o, look, hunterMaps, target);
      var evX = o.player.x, evY = o.player.y;
      if (ev === 'up') evY = o.player.y - 1;
      else if (ev === 'down') evY = o.player.y + 1;
      else if (ev === 'left') evX = o.player.x - 1;
      else if (ev === 'right') evX = o.player.x + 1;
      var evProj = projectedMinHunterDist(o, look, hunterMaps, evX, evY);
      if (evProj > proj || (evProj === proj && ev !== action)) {
        action = ev;
        nextX = evX;
        nextY = evY;
        followedPath = false;
        m.path = [];
        m.tx = -1;
        m.ty = -1;
      }
    }
  }

  // 消耗路径首步
  if (followedPath && m.path.length >= 2) {
    m.path.splice(0, 2);
    if (m.path.length === 0) {
      m.tx = -1;
      m.ty = -1;
    }
  } else if (!followedPath) {
    m.path = [];
    m.tx = -1;
    m.ty = -1;
  }

  // 卡死安全网
  if (m.stuck >= STUCK_LIMIT) {
    var fm = forcedMove(o, look);
    if (fm) {
      action = fm.action;
      nextX = fm.x;
      nextY = fm.y;
    }
    m.stuck = 0;
    m.path = [];
    m.tx = -1;
    m.ty = -1;
  }

  return { action: action, memory: m };
}