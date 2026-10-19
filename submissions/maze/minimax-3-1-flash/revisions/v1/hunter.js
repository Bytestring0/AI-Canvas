'use strict';

/* =========================================================================
 * hunter.js — 追逐者（hunter）策略
 *
 * 每 (tick+1) % hunterEvery === 0 调用一次，必须为所有追逐者同时给出动作。
 * 纯同步、无依赖、无随机（只用 observation 里的数据 + 自己的 memory）。
 *
 * 核心思想（细节见 README.md）：
 *   1) 追逐者每 hunterEvery 个 tick 才动一步，玩家每 tick 动一步。
 *      纯"跟在屁股后面追"永远追不上 —— 真正有价值的是**卡咽喉点**。
 *   2) 三个场把"哪里值得去"变成可计算的量：
 *        costT[x] = x 到玩家当前目标（钥匙/出口）的步数
 *        distP[x] = 玩家到 x 的步数
 *        Hi[x]    = 我到 x 的步数
 *      x 属于"玩家路线" 当且仅当 distP[x] + costT[x] <= OPT + 3。
 *   3) 站位价值 = 我能不能比玩家先到。余量 = distP[x] - Hi[x]*hunterEvery。
 *      余量够就认领这个路点（玩家必须从这儿过）。
 *   4) 认领之后再比一次"封死它能逼玩家多绕多少路"：
 *      把该格临时封掉算一次距离场，取绕路代价最大的那个点 = 真咽喉。
 *   5) 贴身时切换到交战模式：
 *      - 玩家被困住（两次轮询之间没动）且我贴着它 -> 直接踩上去，必中。
 *      - 我能一步到玩家的某个相邻格 -> 去那儿"迎"玩家（它走进来就同格）。
 *      - 否则贴身就压上去。
 *   6) 多个追逐者贪心认领不同路点，形成多点封堵。
 * ========================================================================= */

var DX = [1, 0, -1, 0];
var DY = [0, 1, 0, -1];
var DIRNAME = ['right', 'down', 'left', 'up'];
var INF = 1 << 28;

var ENGAGE_RANGE = 3;   /* 离玩家多近算"贴身交战" */
var TOP_CAND = 6;       /* 每个追逐者最多比较几个候选站位 */

/* ------------------------------------------------------------------ */
/* BFS：dist[x] = 到最近源点的步数（-1 = 不可达）。闸门视为可通行（追逐者可以等）。 */
/* ------------------------------------------------------------------ */
function bfsDist(sources, W, H, pass, blockedCell) {
  var N = W * H;
  var dist = new Int32Array(N);
  var i;
  for (i = 0; i < N; i++) dist[i] = -1;

  var q = new Int32Array(N);
  var head = 0, tail = 0, k;

  for (k = 0; k < sources.length; k++) {
    var s = sources[k];
    if (s < 0 || s >= N || !pass[s] || s === blockedCell || dist[s] === 0) continue;
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
      if (!pass[v] || v === blockedCell || dist[v] >= 0) continue;
      dist[v] = nd; q[tail++] = v;
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
/* 沿着"到目标的距离场"下降一步。distTo[x] = x 到目标的步数。              */
/* ------------------------------------------------------------------ */
function stepToward(from, distTo, W, H, pass, closed) {
  if (distTo[from] <= 0) return 'wait';
  var fx = from % W, fy = (from / W) | 0;
  var best = 'wait', bestD = distTo[from];
  for (var d = 0; d < 4; d++) {
    var nx = fx + DX[d], ny = fy + DY[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    var v = ny * W + nx;
    if (!pass[v] || closed[v]) continue;
    if (distTo[v] < bestD) { bestD = distTo[v]; best = DIRNAME[d]; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
function decide(o) {
  var W = o.width, H = o.height, N = W * H;
  var P = o.player;
  var me = P.y * W + P.x;
  var every = o.hunterEvery || 2;
  var hunters = o.hunters || [];
  var actions = [];
  if (hunters.length === 0) return { actions: actions, memory: null };

  var mem = (o.memory && typeof o.memory === 'object' && !Array.isArray(o.memory)) ? o.memory : {};
  var i, x, y;

  /* --- 通道 --- */
  var pass = new Uint8Array(N);
  for (y = 0; y < H; y++) {
    var row = o.grid[y] || [];
    for (x = 0; x < W; x++) if (row[x] === 0) pass[y * W + x] = 1;
  }
  pass[me] = 1;

  /* --- 闸门（关闭的进不去） --- */
  var closed = new Uint8Array(N);
  var gates = o.gates || [];
  for (i = 0; i < gates.length; i++) {
    var g = gates[i], gi = g.y * W + g.x;
    if (gi >= 0 && gi < N && g.closed) closed[gi] = 1;
  }

  /* --- 玩家目标（钥匙 / 出口）--- */
  var goal = P.hasKey ? o.exit : (o.key || o.exit);
  var goalCell = goal.y * W + goal.x;

  /* --- 距离场 --- */
  var distP = bfsDist([me], W, H, pass, -1);
  var costT = bfsDist([goalCell], W, H, pass, -1);
  var OPT = costT[me];

  var route = new Uint8Array(N);
  if (OPT >= 0) {
    for (i = 0; i < N; i++) {
      if (distP[i] < 0 || costT[i] < 0) continue;
      if (distP[i] + costT[i] <= OPT + 3) route[i] = 1;
    }
  }

  /* --- 玩家的合法邻格（按"走向目标的程度"排序，作为它下一步的预测）--- */
  var neigh = [];
  for (var d = 0; d < 4; d++) {
    var nx = P.x + DX[d], ny = P.y + DY[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    var v = ny * W + nx;
    if (!pass[v] || closed[v]) continue;
    neigh.push({ c: v, cost: costT[v] < 0 ? INF : costT[v] });
  }
  neigh.sort(function (a, b) { return a.cost - b.cost; });

  /* --- 玩家是否被卡住？（两次轮询之间位置没变）--- */
  var posKey = P.x + ',' + P.y;
  var stuck = 0;
  if (typeof mem.p === 'string' && mem.p === posKey) stuck = (mem.s | 0) + 1;
  else stuck = 0;

  /* --- 缓存 --- */
  var claimed = new Uint8Array(N);
  var fields = new Array(N);
  var hiCache = new Array(N);
  var detourCache = new Array(N);

  function fieldTo(cell) {
    var f = fields[cell];
    if (!f) { f = bfsDist([cell], W, H, pass, -1); fields[cell] = f; }
    return f;
  }
  function hiOf(cell) {
    var f = hiCache[cell];
    if (!f) { f = bfsDist([cell], W, H, pass, -1); hiCache[cell] = f; }
    return f;
  }
  /* 把 cell 封死后，玩家要多绕多少步 */
  function detourOf(cell) {
    if (cell === me) return 0;
    var d = detourCache[cell];
    if (d === undefined) {
      var f = bfsDist([goalCell], W, H, pass, cell);
      d = (f[me] < 0 || costT[me] < 0) ? 0 : f[me] - costT[me];
      if (d < 0) d = 0;
      detourCache[cell] = d;
    }
    return d;
  }

  for (var k = 0; k < hunters.length; k++) {
    var h = hunters[k];
    var hcell = h.y * W + h.x;
    var Hi = hiOf(hcell);
    var dToPlayer = distP[hcell];
    var target = -1;

    /* === 交战模式：离玩家够近 === */
    if (dToPlayer >= 0 && dToPlayer <= ENGAGE_RANGE) {
      if (stuck >= 1 && dToPlayer <= 1) {
        target = me;                                   /* 玩家卡住了：踩上去 */
      } else {
        var bestC = -1, bestCost = INF;
        for (i = 0; i < neigh.length; i++) {
          var nc = neigh[i].c;
          var dd = Math.abs((nc % W) - (hcell % W)) + Math.abs(((nc / W) | 0) - ((hcell / W) | 0));
          if (dd !== 1) continue;                      /* 我一步到不了 */
          if (neigh[i].cost < bestCost) { bestCost = neigh[i].cost; bestC = nc; }
        }
        if (bestC >= 0) target = bestC;               /* 去迎玩家 */
        else if (dToPlayer === 1) target = me;        /* 贴不上就压上去 */
        else target = -1;
      }
    }

    /* === 卡点模式：选一个"我先到、而且封得死"的站位 === */
    if (target < 0) {
      var cands = [];
      for (i = 0; i < N; i++) {
        if (!route[i] || claimed[i]) continue;
        if (i === goalCell) continue;                  /* 站在钥匙/出口上没意义：达成即结算 */
        var myArrival = Hi[i] * every;                /* 我到那儿要多少"玩家 tick" */
        var slack = distP[i] - myArrival;
        if (slack < 2) continue;                      /* 到不了 / 几乎同时到 */
        var val = 40 * Math.min(slack, 6 * every) - 8 * costT[i] - 2 * Hi[i];
        cands.push({ c: i, val: val, slack: slack });
      }
      cands.sort(function (a, b) { return b.val - a.val; });
      var top = cands.length < TOP_CAND ? cands.length : TOP_CAND;
      var bestPick = -1, bestScore = -Infinity;
      for (i = 0; i < top; i++) {
        var cc = cands[i].c;
        var det = detourOf(cc);                       /* 封住它能逼玩家多绕多远 */
        var sc = det * 6 + cands[i].val;              /* 绕路代价优先：能逼玩家绕最远的点最值钱 */
        if (sc > bestScore) { bestScore = sc; bestPick = cc; }
      }
      if (bestPick >= 0) target = bestPick;
      else target = me;                               /* 兜底：直接追玩家 */
    }

    if (target < 0) target = me;
    var action = stepToward(hcell, fieldTo(target), W, H, pass, closed);
    actions.push({ id: h.id, action: action });
    claimed[target] = 1;
  }

  return { actions: actions, memory: { p: posKey, s: stuck } };
}