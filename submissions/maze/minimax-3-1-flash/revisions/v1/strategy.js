'use strict';

/* =========================================================================
 * strategy.js — 走迷宫（runner）策略
 *
 * 纯同步、无依赖、无随机、无 Date/performance/crypto。
 * 顶层只暴露 decide(observation) -> { action, memory }。
 *
 * 核心思想（细节见 README.md）：
 *   1) 目标选择：没钥匙去钥匙，有钥匙去出口；安全且代价小的时候顺路捡晶片。
 *   2) 距离场：
 *        costT[x]  = x -> 当前目标的加权代价（闸门格 +1，因为可能要等）
 *        hd[x]     = 任意追逐者 -> x 的步数（威胁场）
 *        distP[x]  = 玩家 -> x 的步数（用来算"绕路去捡晶片"值不值）
 *   3) 代价统一尺度：1 tick ≈ TICK_COST 分，1 点血 ≈ HP_COST 分。
 *      分数上 1 点血值 167 分，1 tick 值 2000/maxTicks ≈ 2~6 分，
 *      所以"血很贵，但命更贵"——绝不用命换速度。
 *   4) 猎手的威胁被折进"风险场"再并入路径代价（weight = 门代价 + 风险），
 *      于是"绕路"与"硬闯"变成一次全局比较，而不是见猎手就逃。
 *   5) 三条反退化规则，防止"卡住 / 横跳 / 空等"：
 *        - 原地不动超过 3 tick，等待的惩罚随 tick 增长，逼着它动
 *        - 退回上一格会被罚，连环回头罚得更重
 *        - 回到两拍前的格子（A→B→A）直接重罚，禁掉两格横跳
 * ========================================================================= */

var DX = [1, 0, -1, 0];
var DY = [0, 1, 0, -1];
var DIRNAME = ['right', 'down', 'left', 'up'];
var INF = 1 << 28;

/* 代价尺度 */
var TICK_COST = 3.0;      /* 1 tick 的分数代价 */
var HP_COST = 55.0;       /* 1 点血的分数代价（≈167 分） */
var ALT_TOL = 15;         /* 为躲一个猎手最多多走的 tick 数 */

/* 捡晶片 */
var COIN_TOLERANCE = 12;
var COIN_SAFE_DIST = 5;

/* ------------------------------------------------------------------ */
/* Dijkstra：dist[x] = 从 x 走到 (sx,sy) 的最小代价。                     */
/* 进入某格的代价 = 1 + extra[x]；blocked[x]=1 的格子直接不可通行。          */
/* ------------------------------------------------------------------ */
function costToTarget(sx, sy, W, H, pass, extra, blocked) {
  var N = W * H;
  var dist = new Int32Array(N);
  var i;
  for (i = 0; i < N; i++) dist[i] = INF;

  var s = sy * W + sx;
  if (!pass[s] || (blocked && blocked[s])) return dist;

  var cap = N * 8 + 32;
  var hk = new Int32Array(cap);
  var hv = new Int32Array(cap);
  var hn = 0;

  dist[s] = 0;
  hk[0] = 0; hv[0] = s; hn = 1;

  while (hn > 0) {
    var u = hv[0], du = hk[0];
    hn--;
    if (hn > 0) { hk[0] = hk[hn]; hv[0] = hv[hn]; }

    var j = 0;
    for (;;) {
      var l = 2 * j + 1, r = l + 1, m = j;
      if (l < hn && hk[l] < hk[m]) m = l;
      if (r < hn && hk[r] < hk[m]) m = r;
      if (m === j) break;
      var tk = hk[m]; hk[m] = hk[j]; hk[j] = tk;
      var tv = hv[m]; hv[m] = hv[j]; hv[j] = tv;
      j = m;
    }

    if (du !== dist[u]) continue;

    var ux = u % W, uy = (u / W) | 0;
    for (var d = 0; d < 4; d++) {
      var nx = ux + DX[d], ny = uy + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var v = ny * W + nx;
      if (!pass[v] || (blocked && blocked[v])) continue;
      var nd = du + 1 + extra[v];
      if (nd < dist[v]) {
        dist[v] = nd;
        hk[hn] = nd; hv[hn] = v; hn++;
        var p = (hn - 1) >> 1;
        while (p > 0) {
          var q = (p - 1) >> 1;
          if (hk[q] <= hk[p]) break;
          var a = hk[q]; hk[q] = hk[p]; hk[p] = a;
          var b = hv[q]; hv[q] = hv[p]; hv[p] = b;
          p = q;
        }
      }
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
/* 多源 BFS：dist[x] = 到最近源点的步数（-1 = 不可达）。单位权，闸门视为可通行。 */
/* ------------------------------------------------------------------ */
function bfsDist(sources, W, H, pass) {
  var N = W * H;
  var dist = new Int32Array(N);
  var i;
  for (i = 0; i < N; i++) dist[i] = -1;

  var q = new Int32Array(N);
  var head = 0, tail = 0, k;

  for (k = 0; k < sources.length; k++) {
    var s = sources[k];
    if (s < 0 || s >= N || !pass[s] || dist[s] === 0) continue;
    dist[s] = 0; q[tail++] = s;
  }

  while (head < tail) {
    var u = q[head++];
    var ux = u % W, uy = (u / W) | 0;
    var nd = dist[u] + 1;
    for (var d = 0; d < 4; d++) {
      var nx = ux + DX[d], ny = uy + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var v = ny * W + nx;
      if (!pass[v] || dist[v] >= 0) continue;
      dist[v] = nd; q[tail++] = v;
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
function decide(o) {
  var W = o.width, H = o.height, N = W * H;
  var P = o.player;
  var px = P.x, py = P.y;
  var me = py * W + px;
  var tick = o.tick | 0;
  var mem = (o.memory && typeof o.memory === 'object' && !Array.isArray(o.memory)) ? o.memory : {};

  var i, x, y;

  /* --- 静态通道 --- */
  var pass = new Uint8Array(N);
  for (y = 0; y < H; y++) {
    var row = o.grid[y] || [];
    for (x = 0; x < W; x++) if (row[x] === 0) pass[y * W + x] = 1;
  }
  pass[me] = 1;

  /* --- 闸门 --- */
  var extra = new Uint8Array(N), closed = new Uint8Array(N);
  var gates = o.gates || [];
  for (i = 0; i < gates.length; i++) {
    var g = gates[i], gi = g.y * W + g.x;
    if (gi >= 0 && gi < N) { extra[gi] = 1; if (g.closed) closed[gi] = 1; }
  }

  /* --- 机关（本 tick 激活的） --- */
  var trap = new Uint8Array(N);
  var traps = o.traps || [];
  for (i = 0; i < traps.length; i++) {
    var tr = traps[i];
    if (tr.active) trap[tr.y * W + tr.x] = 1;
  }

  /* --- 晶片 --- */
  var coinAt = new Uint8Array(N);
  var coins = o.coins || [];
  var coinCells = [];
  for (i = 0; i < coins.length; i++) {
    var ci = coins[i].y * W + coins[i].x;
    coinAt[ci] = 1; coinCells.push(ci);
  }

  /* --- 已访问（探索分） --- */
  var seen = new Uint8Array(N);
  var vis = o.visited || [];
  for (i = 0; i < vis.length; i++) {
    var s = String(vis[i]), comma = s.indexOf(',');
    if (comma < 0) continue;
    var vx = +s.slice(0, comma), vy = +s.slice(comma + 1);
    if (vx >= 0 && vy >= 0 && vx < W && vy < H) seen[vy * W + vx] = 1;
  }

  /* --- 目标 --- */
  var hasKey = !!P.hasKey;
  var goal = hasKey ? o.exit : (o.key || o.exit);
  var goalCell = goal.y * W + goal.x;

  /* --- 追逐者位置与距离场 --- */
  var hs = o.hunters || [];
  var hsrc = [], hunterAt = new Uint8Array(N);
  for (i = 0; i < hs.length; i++) {
    var hi = hs[i].y * W + hs[i].x;
    hsrc.push(hi); hunterAt[hi] = 1;
  }
  var hd = bfsDist(hsrc, W, H, pass);
  var distP = bfsDist([me], W, H, pass);
  var nearestHunter = hd[me] < 0 ? 999 : hd[me];
  var huntersMoveNow = ((tick + 1) % o.hunterEvery) === 0;

  /* --- 风险场：把"离猎手多近"折成代价，让"绕路"和"硬闯"变成全局比较 --- */
  var risk = new Uint8Array(N);
  var RISK_CO = 12, RISK_NEAR_MOVE = 6, RISK_NEAR = 3, RISK_FAR = 1;
  for (i = 0; i < N; i++) {
    var t = hd[i];
    if (t < 0) continue;
    if (t === 0) risk[i] = RISK_CO;
    else if (t === 1) risk[i] = huntersMoveNow ? RISK_NEAR_MOVE : RISK_NEAR;
    else if (t === 2) risk[i] = RISK_FAR;
  }

  /* 门 + 风险 一起作为"进入某格"的代价 */
  var weight = new Uint8Array(N);
  for (i = 0; i < N; i++) weight[i] = extra[i] + risk[i];

  var costT = costToTarget(goal.x, goal.y, W, H, pass, weight, null);

  /* --- 记忆：上一格、回头计数、停滞计数 --- */
  var posKey = px + ',' + py;
  var prevCell = -1;
  if (typeof mem.p === 'string' && mem.p.length) {
    var pm = mem.p.split(',');
    var ppx = +pm[0], ppy = +pm[1];
    if (ppx >= 0 && ppy >= 0 && ppx < W && ppy < H) prevCell = ppy * W + ppx;
  }
  var prev2Cell = -1;
  if (typeof mem.q === 'string' && mem.q.length) {
    var qm = mem.q.split(',');
    var qx = +qm[0], qy = +qm[1];
    if (qx >= 0 && qy >= 0 && qx < W && qy < H) prev2Cell = qy * W + qx;
  }
  var bounce = mem.b | 0;
  var stall = (prevCell === me) ? (mem.st | 0) + 1 : 0;

  /* --- 猎手是否正好堵在下一步上？是的话看看能不能便宜地绕过去 --- */
  var costGo = costT;
  var nextCell = -1, nextCost = INF;
  for (var d0 = 0; d0 < 4; d0++) {
    var nx0 = px + DX[d0], ny0 = py + DY[d0];
    if (nx0 < 0 || ny0 < 0 || nx0 >= W || ny0 >= H) continue;
    var c0 = ny0 * W + nx0;
    if (!pass[c0] || closed[c0] || costT[c0] >= nextCost) continue;
    nextCost = costT[c0]; nextCell = c0;
  }
  if (nextCell >= 0 && hunterAt[nextCell] && costT[me] < INF) {
    var costT2 = costToTarget(goal.x, goal.y, W, H, pass, weight, hunterAt);
    if (costT2[me] < INF && costT2[me] <= costT[me] + ALT_TOL) costGo = costT2;
  }

  /* --- 顺路捡晶片？ --- */
  var timeLeft = (o.maxTicks | 0) - tick;
  var target = -1;
  var canHunt = costGo[me] < INF && (timeLeft - costGo[me]) > (COIN_TOLERANCE + 6);

  if (canHunt && nearestHunter > 3) {
    var commit = -1;
    if (typeof mem.c === 'string' && mem.c.length) {
      var cm = mem.c.split(',');
      var cxi = +cm[0], cyi = +cm[1];
      if (cxi >= 0 && cyi >= 0 && cxi < W && cyi < H) commit = cyi * W + cxi;
    }
    if (commit >= 0 && coinAt[commit] && distP[commit] >= 0) {
      var over = distP[commit] + costT[commit] - costT[me];
      if (over <= COIN_TOLERANCE + 4) target = commit;
    }
    if (target < 0 && nearestHunter > COIN_SAFE_DIST) {
      var bestOver = INF;
      for (i = 0; i < coinCells.length; i++) {
        var cc = coinCells[i];
        if (distP[cc] < 0 || hd[cc] < COIN_SAFE_DIST) continue;
        var ov = distP[cc] + costT[cc] - costT[me];
        if (ov > COIN_TOLERANCE || ov >= bestOver) continue;
        bestOver = ov; target = cc;
      }
    }
  }

  var costUse = costGo;
  if (target >= 0) {
    costUse = costToTarget(target % W, (target / W) | 0, W, H, pass, weight, null);
  }

  /* --- 候选动作打分 --- */
  var bestAction = 'wait', bestScore = -Infinity, bestDir = -1, bestCell = me;

  for (var d = 0; d <= 4; d++) {
    var c, action, isWait = (d === 4);
    if (!isWait) {
      var nx = px + DX[d], ny = py + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      c = ny * W + nx;
      action = DIRNAME[d];
      if (!pass[c] || closed[c]) continue;
    } else {
      c = me; action = 'wait';
    }

    var cc2 = costUse[c];
    var sc;
    if (cc2 >= INF) sc = -1e6;                 /* 走不到（被猎手围死） */
    else sc = -TICK_COST * cc2;

    if (coinAt[c]) sc += 8;                     /* 顺手就捡 */
    if (trap[c]) sc -= HP_COST;                 /* 本 tick 踩机关 = 掉 1 血 */
    if (!seen[c]) sc += 0.05;                   /* 探索分（极小权重） */

    /* 猎手风险已经折进 costUse（风险场），这里只处理"同格"这种硬冲突 */
    var th = hd[c];
    if (th === 0) sc -= 12;                     /* 站到猎手格上：多半要掉血 */
    else if (th < 0) sc -= 6;

    if (!isWait && prevCell >= 0 && c === prevCell) {
      sc -= (bounce === 0 ? 12 : 50);           /* 回头：第一次轻罚，连环回头重罚 */
    }
    if (!isWait && prev2Cell >= 0 && c === prev2Cell) {
      sc -= 60;                                 /* 回到两拍前的格子 = 两格横跳，必须禁掉 */
    }

    if (isWait) {
      if (th <= 1) sc -= 30;                    /* 猎手在旁边时"站着不动"≈送死 */
      else if (th === 2) sc -= 6;
      else if (th === 3) sc -= 1.5;
      if (stall > 3) sc -= 6 * (stall - 3);     /* 原地太久：越来越想动 */
      /* 脚下的机关下一拍就要开：待不住 */
      if (trap[me] && willBeActive(o.traps, me, W, tick + 1)) sc -= HP_COST;
    }

    if (c === goalCell) sc += 1e6;              /* 钥匙 / 出口一定要拿 */

    if (sc > bestScore) { bestScore = sc; bestAction = action; bestDir = (isWait ? -1 : d); bestCell = c; }
  }

  var memory = {
    c: target >= 0 ? (target % W) + ',' + ((target / W) | 0) : null,
    d: bestDir,
    p: posKey,
    q: (typeof mem.p === 'string') ? mem.p : null,
    b: (prevCell >= 0 && bestCell === prevCell) ? bounce + 1 : 0,
    st: (bestCell === me) ? stall + 1 : 0
  };
  return { action: bestAction, memory: memory };
}

/* 该格上的机关在 tick t 是否激活 */
function willBeActive(traps, cell, W, t) {
  if (!traps) return false;
  var x = cell % W, y = (cell / W) | 0;
  for (var i = 0; i < traps.length; i++) {
    var tr = traps[i];
    if (tr.x !== x || tr.y !== y) continue;
    return ((t + tr.phase) % tr.period) < tr.on;
  }
  return false;
}