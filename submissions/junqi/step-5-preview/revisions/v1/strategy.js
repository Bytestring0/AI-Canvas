/*
 * 将军棋（junqi-2）策略 —— "梯度洪流"（Gradient Tide）
 *
 * 设计要点：
 *  1. 地形记忆：一旦侦察过某格地形就永不忘却（存进 memory，压缩成字符串）。
 *  2. 敌方将军记忆：见过就记住位置，直到其 owner/地形信息证明他已死亡。
 *  3. 每 tick 用一次多源 Dijkstra 建立"价值距离场"：
 *       - 与我方领土接壤的中立/敌方格子是目标（城市权重最高，敌方将军最高）；
 *       - 穿越不同区域的代价不同（己方 1 / 中立 2 / 未知地形 3 / 敌方 5）；
 *       - 距离场给出每个格子"离最近的高价值目标还有多远"。
 *  4. 在 4 条移动预算内贪心挑选"沿梯度下降且能真实吃下目标"的移动，
 *     按吃下目标的价值 + 出发兵力打分，同 tick 内带扩散惩罚，避免全军挤一处。
 *  5. 防守模式：将军附近敌军明显强于我方时，只允许局部反击，不再外送兵力。
 *  6. 全程无随机、无时间依赖，纯同步算法，结果可复现。
 */

var DIR_X = [0, 1, 0, -1];
var DIR_Y = [-1, 0, 1, 0];
var DIR_NAME = ['up', 'right', 'down', 'left'];
var INF = 536870912; // 1 << 29

function decide(o) {
  var W = o.width | 0, H = o.height | 0, N = W * H;
  var me = o.you.id | 0, myTeam = o.you.team | 0, tick = o.tick | 0;
  var PC = o.playerCount | 0;
  var players = o.players || [];

  /* ---------------- 1. 地形记忆（跨 tick 持久） ---------------- */
  var mem = (o.memory && typeof o.memory === 'object') ? o.memory : null;
  var ter = new Int8Array(N);
  var i, x, y, d;
  for (i = 0; i < N; i++) ter[i] = -1;
  if (mem && typeof mem.t === 'string' && mem.t.length === N) {
    var ms = mem.t;
    for (i = 0; i < N; i++) ter[i] = ms.charCodeAt(i) - 49; // '0'..'4' -> -1..3
  }
  var ot = o.terrain;
  for (y = 0; y < H; y++) {
    var trow = ot[y], tbase = y * W;
    for (x = 0; x < W; x++) {
      var tv = trow[x];
      if (tv >= 0) ter[tbase + x] = tv; // 新情报覆盖，旧情报永不丢失
    }
  }
  var chars = new Array(N);
  for (i = 0; i < N; i++) chars[i] = String.fromCharCode(ter[i] + 49);
  var tstr = chars.join('');

  /* ---------------- 2. 当前可见的归属与兵力 ---------------- */
  var owner = new Int8Array(N);
  var army = new Int32Array(N);
  var oo = o.owner, aa = o.army;
  for (y = 0; y < H; y++) {
    var orow = oo[y], arow = aa[y], base = y * W;
    for (x = 0; x < W; x++) {
      owner[base + x] = orow[x];
      army[base + x] = arow[x];
    }
  }

  var teamOf = new Int8Array(PC);
  for (i = 0; i < PC; i++) teamOf[i] = -1;
  for (i = 0; i < players.length; i++) {
    var p = players[i];
    if (p.id >= 0 && p.id < PC) teamOf[p.id] = p.team;
  }
  function sameTeam(a, b) {
    return a >= 0 && a < PC && b >= 0 && b < PC && teamOf[a] === teamOf[b];
  }

  /* ---------------- 3. 敌方将军记忆 ---------------- */
  var gens = [];
  if (mem && Array.isArray(mem.g)) {
    for (i = 0; i < mem.g.length; i++) {
      var mg = mem.g[i];
      if (mg && mg.length === 4) gens.push({ id: mg[0], x: mg[1], y: mg[2], t: mg[3] });
    }
  }
  var aliveOf = {};
  for (i = 0; i < players.length; i++) aliveOf[players[i].id] = players[i].alive;
  var myTotal = 0, otherTotal = 0, myLand = 0, otherLand = 0;
  for (i = 0; i < players.length; i++) {
    var pl = players[i];
    if (sameTeam(pl.id, me)) { myTotal += pl.army; myLand += pl.land; }
    else { otherTotal += pl.army; otherLand += pl.land; }
  }
  // 用当前观察刷新将军位置
  for (i = 0; i < N; i++) {
    if (ter[i] !== 3) continue;
    var ow = owner[i];
    if (ow >= 0 && ow !== me && !sameTeam(ow, me)) {
      var gx2 = i % W, gy2 = (i / W) | 0;
      var found = false;
      for (var j = 0; j < gens.length; j++) {
        if (gens[j].id === ow) {
          gens[j].x = gx2; gens[j].y = gy2; gens[j].t = tick; found = true; break;
        }
      }
      if (!found) gens.push({ id: ow, x: gx2, y: gy2, t: tick });
    }
  }
  // 清掉已死亡 / 已被攻陷（地形变成城市）的记录
  var gens2 = [];
  for (i = 0; i < gens.length; i++) {
    var g = gens[i];
    var gidx = g.y * W + g.x;
    if (aliveOf[g.id] === false) continue;
    if (ter[gidx] !== 3 && ter[gidx] !== -1) continue;
    gens2.push(g);
  }
  gens = gens2;

  /* ---------------- 4. 多源 Dijkstra 价值距离场 ---------------- */
  var dist = new Int32Array(N);
  for (i = 0; i < N; i++) dist[i] = INF;

  var aggressive = (myTotal > 2.2 * otherTotal + 20) || (myLand > 1.6 * otherLand + 10);
  var enemyGoalW = aggressive ? 2 : 4;

  // 4a. 与我方接壤的可争夺格
  for (i = 0; i < N; i++) {
    var ow2 = owner[i];
    if (ow2 < 0 || !sameTeam(ow2, me)) continue;
    var cx = i % W, cy = (i / W) | 0;
    for (d = 0; d < 4; d++) {
      var nx = cx + DIR_X[d], ny = cy + DIR_Y[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var j2 = ny * W + nx;
      if (ter[j2] === 1) continue;
      var tow = owner[j2];
      if (tow >= 0 && sameTeam(tow, me)) continue;
      var w;
      if (ter[j2] === 2) w = 0;          // 城市：最想打
      else if (tow === -1) w = 2;        // 中立空地
      else w = enemyGoalW;               // 敌方领土
      if (w < dist[j2]) dist[j2] = w;
    }
  }
  // 4b. 记忆中的敌方将军：最高优先级目标（已被我方/队友占领的跳过）
  for (i = 0; i < gens.length; i++) {
    var gg = gens[i].y * W + gens[i].x;
    if (ter[gg] === 1) continue;
    var gow = owner[gg];
    if (gow >= 0 && sameTeam(gow, me)) continue;
    if (dist[gg] > 0) dist[gg] = 0;
  }

  // 4c. Dijkstra（二叉堆，数值编码 dist*N+idx）
  var heap = [];
  function hpush(v) {
    heap.push(v);
    var k = heap.length - 1;
    while (k > 0) {
      var par = (k - 1) >> 1;
      if (heap[par] <= heap[k]) break;
      var tmp = heap[par]; heap[par] = heap[k]; heap[k] = tmp;
      k = par;
    }
  }
  function hpop() {
    var top = heap[0];
    var last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      var k = 0;
      for (;;) {
        var l = 2 * k + 1, r = l + 1, m = k;
        if (l < heap.length && heap[l] < heap[m]) m = l;
        if (r < heap.length && heap[r] < heap[m]) m = r;
        if (m === k) break;
        var t2 = heap[m]; heap[m] = heap[k]; heap[k] = t2;
        k = m;
      }
    }
    return top;
  }
  for (i = 0; i < N; i++) if (dist[i] < INF) hpush(dist[i] * N + i);
  while (heap.length) {
    var v = hpop();
    var dcur = (v / N) | 0;
    var idx = v - dcur * N;
    if (dcur > dist[idx]) continue;
    var px = idx % W, py = (idx / W) | 0;
    for (d = 0; d < 4; d++) {
      var qx = px + DIR_X[d], qy = py + DIR_Y[d];
      if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
      var jq = qy * W + qx;
      if (ter[jq] === 1) continue;
      var c;
      var qow = owner[jq];
      if (ter[jq] < 0) c = 3;                       // 迷雾：可通行但不诱人
      else if (qow >= 0 && sameTeam(qow, me)) c = 1; // 己方后方：畅通
      else if (qow === -1) c = 2;                    // 中立
      else c = 5;                                    // 敌占区：尽量绕开
      var nd = dcur + c;
      if (nd < dist[jq]) { dist[jq] = nd; hpush(nd * N + jq); }
    }
  }

  /* ---------------- 5. 将军周边威胁评估（防守模式） ---------------- */
  var gen = o.you.general;
  var gi = (gen && gen.x >= 0) ? gen.y * W + gen.x : -1;
  var defensive = false;
  if (gi >= 0 && gi < N && ter[gi] !== 1) {
    var gxp = gen.x, gyp = gen.y;
    var threatArmy = 0, myNear = Math.max(0, army[gi]);
    var R = 4;
    var y0 = gyp - R > 0 ? gyp - R : 0, y1 = gyp + R < H - 1 ? gyp + R : H - 1;
    var x0 = gxp - R > 0 ? gxp - R : 0, x1 = gxp + R < W - 1 ? gxp + R : W - 1;
    for (y = y0; y <= y1; y++) {
      for (x = x0; x <= x1; x++) {
        var idx2 = y * W + x;
        var ow3 = owner[idx2];
        if (ow3 < 0) continue;
        var av = Math.max(0, army[idx2]);
        if (sameTeam(ow3, me)) myNear += av;
        else threatArmy += av;
      }
    }
    if (threatArmy > myNear * 1.5 + 2) defensive = true;
  }

  /* ---------------- 6. 贪心挑选最多 4 条移动 ---------------- */
  var moves = [];
  var lArmy = army.slice();
  var lOwner = owner.slice();
  var usedFrom = new Uint8Array(N);
  var chosen = []; // 本 tick 已选出发格，用于扩散惩罚

  for (var iter = 0; iter < 4; iter++) {
    var bestScore = -1e18, bestFrom = -1, bestDir = -1, bestFull = false, bestK = 0, bestTo = -1, bestDef = 0;
    for (i = 0; i < N; i++) {
      if (usedFrom[i]) continue;
      var fow = lOwner[i];
      if (fow < 0 || !sameTeam(fow, me)) continue;
      var n = lArmy[i];
      if (n < 2) continue;
      if (i === gi) {
        if (defensive) continue;      // 被威胁时将军不出兵
        if (n < 3) continue;
      }
      var di = dist[i];
      if (di >= INF) continue;
      var fx = i % W, fy = (i / W) | 0;
      for (d = 0; d < 4; d++) {
        var tx = fx + DIR_X[d], ty = fy + DIR_Y[d];
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        var j = ty * W + tx;
        var tj = ter[j];
        if (tj !== 0 && tj !== 2 && tj !== 3) continue; // 山地或未侦察
        var tow2 = lOwner[j];
        if (tow2 >= 0 && sameTeam(tow2, me)) continue;  // 己方/队友：本策略不做内部增援
        var dj = dist[j];
        if (dj >= di) continue;                          // 必须沿梯度指向目标

        var def = lArmy[j];
        if (def < 0) def = 0;
        var kHalf = n >> 1;
        var kFull = n - 1;
        var isGen = (tj === 3 && tow2 >= 0);
        var isCity = (tj === 2);
        var k, full;
        if (kHalf > def) { k = kHalf; full = false; }
        else if (kFull > def) {
          if (isGen || isCity || (tow2 >= 0 && kFull - def >= 3)) { k = kFull; full = true; }
          else continue; // 吃不下就继续攒，不做无谓送兵
        } else continue;

        if (defensive) {
          // 只反击将军附近的敌军
          if (tow2 < 0) continue;
          if (Math.abs(tx - gxp) > 4 || Math.abs(ty - gyp) > 4) continue;
        }

        var score = 0;
        if (isGen) score += 1000;
        else if (isCity) score += 300;
        else if (tow2 >= 0) score += 120;
        else score += 60;
        score += Math.min(n, 80) * 0.5;
        if (full) score -= 40;
        // 扩散惩罚：避免 4 条移动全挤在同一处
        for (var ci = 0; ci < chosen.length; ci++) {
          var ch = chosen[ci];
          if (Math.abs(ch[0] - fx) <= 3 && Math.abs(ch[1] - fy) <= 3) { score -= 30; break; }
        }
        if (score > bestScore) {
          bestScore = score;
          bestFrom = i; bestDir = d; bestFull = full; bestK = k; bestTo = j; bestDef = def;
        }
      }
    }
    if (bestFrom < 0) break;

    var m = {
      from: { x: bestFrom % W, y: (bestFrom / W) | 0 },
      dir: DIR_NAME[bestDir],
      half: !bestFull
    };
    moves.push(m);
    // 本地模拟结算：目标必为非己方且 k > 守军，因此一定是攻占
    lArmy[bestFrom] -= bestK;
    lOwner[bestTo] = me;
    lArmy[bestTo] = bestK - bestDef;
    usedFrom[bestFrom] = 1;
    usedFrom[bestTo] = 1;
    chosen.push([bestFrom % W, (bestFrom / W) | 0]);
  }

  var memOut = { t: tstr, g: [] };
  for (i = 0; i < gens.length; i++) {
    memOut.g.push([gens[i].id, gens[i].x, gens[i].y, gens[i].t]);
  }
  return { moves: moves, memory: memOut };
}
