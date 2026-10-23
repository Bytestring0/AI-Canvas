'use strict';

/* =============================================================================
 * 将军棋 / junqi-2  ——  strategy.js
 * -----------------------------------------------------------------------------
 * 纯同步、无副作用、确定性的策略实现。
 * 入口：decide(observation) -> { moves: Move[], memory: any }
 * 无 import / export / 第三方依赖 / 网络 / DOM / 时间源 / 随机源。
 * ========================================================================== */

/* 不可达距离。用有限大整数而非 Infinity，便于放进 Int32Array 并做算术比较。 */
var INF = 0x3fffffff;

/* 方向表：上、右、下、左，与输出 dir 字符串一一对应。 */
var DX = [0, 1, 0, -1];
var DY = [-1, 0, 1, 0];
var DIRS = ['up', 'right', 'down', 'left'];

/* =============================================================================
 * 入口。协议规定"执行异常"直接判负出局，因此这里兜一层：
 * 任何未预料的异常都降级为"本 tick 待命 + 重置记忆"，而不是让整局结束。
 * 正常路径不会走到 catch。
 * ========================================================================== */
function decide(observation) {
  try {
    return decideInner(observation);
  } catch (e) {
    return { moves: [], memory: null };
  }
}

function decideInner(o) {
  var W = o.width | 0;
  var H = o.height | 0;
  var N = W * H;
  var me = o.you.id | 0;
  var myTeam = o.you.team | 0;
  var tick = o.tick | 0;
  var pc = o.playerCount | 0;

  /* ---------------------------------------------------------------------
   * 0. 记忆体
   *    mem.eg[pid] = [x, y, seenTick, seenArmy]
   *    terrain 由服务器永久保留，无需自己存地图，因此记忆体极小。
   * ------------------------------------------------------------------ */
  var mem = o.memory;
  if (!mem || typeof mem !== 'object' || mem.v !== 2 || !mem.eg || typeof mem.eg !== 'object') {
    mem = { v: 2, eg: {} };
  }
  var noop = { moves: [], memory: mem };

  if (!o.you.alive || !o.you.general) return noop;
  var gx = o.you.general.x | 0;
  var gy = o.you.general.y | 0;
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return noop;

  /* ---------------------------------------------------------------------
   * 1. 玩家表
   * ------------------------------------------------------------------ */
  var teamOf = new Int32Array(pc);
  var aliveP = new Uint8Array(pc);
  for (var pi = 0; pi < pc; pi++) {
    teamOf[pi] = o.players[pi].team | 0;
    aliveP[pi] = o.players[pi].alive ? 1 : 0;
  }

  /* ---------------------------------------------------------------------
   * 2. 展平地图
   * ------------------------------------------------------------------ */
  var terr = new Int8Array(N);
  var own = new Int16Array(N);
  var arm = new Int32Array(N);
  for (var y = 0; y < H; y++) {
    var tr = o.terrain[y], ow = o.owner[y], ar = o.army[y];
    var base = y * W;
    for (var x = 0; x < W; x++) {
      var i = base + x;
      terr[i] = tr[x];
      own[i] = ow[x];
      arm[i] = ar[x];
    }
  }
  var genIdx = gy * W + gx;

  /* ---------------------------------------------------------------------
   * 3. 敌方将军记忆维护
   * ------------------------------------------------------------------ */
  for (var s = 0; s < N; s++) {
    if (own[s] === -2) continue;
    if (terr[s] === 3) {
      var ep = own[s];
      if (ep >= 0 && ep !== me && teamOf[ep] !== myTeam) {
        var ex = s % W;
        mem.eg[ep] = [ex, (s - ex) / W, tick, arm[s] > 0 ? arm[s] : 0];
      }
    }
  }
  for (var key in mem.eg) {
    var q = +key;
    var rec = mem.eg[key];
    if (!rec || rec.length < 3 || !(q >= 0) || q >= pc || !aliveP[q] || teamOf[q] === myTeam) {
      delete mem.eg[key];
      continue;
    }
    var ridx = (rec[1] | 0) * W + (rec[0] | 0);
    if (ridx < 0 || ridx >= N) { delete mem.eg[key]; continue; }
    if (own[ridx] !== -2 && (own[ridx] !== q || terr[ridx] !== 3)) delete mem.eg[key];
  }

  /* ---------------------------------------------------------------------
   * 4. BFS 距离场
   * ------------------------------------------------------------------ */
  var queue = new Int32Array(N);

  function bfs(src) {
    var dist = new Int32Array(N);
    dist.fill(INF);
    dist[src] = 0;
    var qh = 0, qt = 1;
    queue[0] = src;
    while (qh < qt) {
      var cur = queue[qh++];
      var nd = dist[cur] + 1;
      var cx = cur % W;
      var cy = (cur - cx) / W;
      var nb;
      if (cx > 0) { nb = cur - 1; if (terr[nb] !== 1 && dist[nb] > nd) { dist[nb] = nd; queue[qt++] = nb; } }
      if (cx + 1 < W) { nb = cur + 1; if (terr[nb] !== 1 && dist[nb] > nd) { dist[nb] = nd; queue[qt++] = nb; } }
      if (cy > 0) { nb = cur - W; if (terr[nb] !== 1 && dist[nb] > nd) { dist[nb] = nd; queue[qt++] = nb; } }
      if (cy + 1 < H) { nb = cur + W; if (terr[nb] !== 1 && dist[nb] > nd) { dist[nb] = nd; queue[qt++] = nb; } }
    }
    return dist;
  }

  var dMe = bfs(genIdx);

  /* ---------------------------------------------------------------------
   * 5. 将军威胁评估：敌方 a 军距 d 步，抵达时约剩 a-d
   * ------------------------------------------------------------------ */
  var threatNear = 0;
  for (var t1 = 0; t1 < N; t1++) {
    var o1 = own[t1];
    if (o1 < 0 || o1 === me) continue;
    if (o1 < pc && teamOf[o1] === myTeam) continue;
    var a1 = arm[t1];
    if (a1 < 2) continue;
    var d1 = dMe[t1];
    if (d1 <= 6) {
      var v1 = a1 - d1;
      if (v1 > threatNear) threatNear = v1;
    }
  }

  /* ---------------------------------------------------------------------
   * 6. 目标选择
   *    kind 3 守家 / 1 斩首 / 2 打城 / 0 纯扩张
   * ------------------------------------------------------------------ */
  var bestEG = -1, bestEGd = INF;
  for (var k2 in mem.eg) {
    var p2 = +k2;
    if (!aliveP[p2] || teamOf[p2] === myTeam) continue;
    var r2 = mem.eg[k2];
    var i2 = (r2[1] | 0) * W + (r2[0] | 0);
    if (i2 < 0 || i2 >= N) continue;
    var dd2 = dMe[i2];
    if (dd2 < bestEGd) { bestEGd = dd2; bestEG = i2; }
  }

  var bestCity = -1, bestCityd = INF;
  for (var c1 = 0; c1 < N; c1++) {
    if (terr[c1] !== 2) continue;
    var oc = own[c1];
    if (oc === me) continue;
    if (oc >= 0 && oc < pc && teamOf[oc] === myTeam) continue;
    var dc = dMe[c1];
    if (dc < bestCityd) { bestCityd = dc; bestCity = c1; }
  }

  var goal = -1, goalKind = 0;
  if (threatNear > arm[genIdx]) {
    goal = genIdx; goalKind = 3;
  } else if (bestEG >= 0 && (bestCity < 0 || bestEGd <= bestCityd + 6)) {
    goal = bestEG; goalKind = 1;
  } else if (bestCity >= 0) {
    goal = bestCity; goalKind = 2;
  } else if (bestEG >= 0) {
    goal = bestEG; goalKind = 1;
  }

  var dGoal = null;
  if (goal === genIdx) dGoal = dMe;
  else if (goal >= 0) dGoal = bfs(goal);

  /* ---------------------------------------------------------------------
   * 7. 贪心挑 4 步，影子模拟
   * ------------------------------------------------------------------ */
  var myCells = new Int32Array(N + 4);   /* +4：本 tick 最多新占 4 格，留出余量 */
  var myCount = 0;
  for (var m0 = 0; m0 < N; m0++) if (own[m0] === me) myCells[myCount++] = m0;

  var used = new Uint8Array(N);
  var fresh = new Uint8Array(N);
  var moves = [];

  /* 方向表提到局部：顶层 var 在 Worker 里是全局属性查找，热路径上代价明显 */
  var ddx = DX, ddy = DY;

  var gArmy = arm[genIdx];
  var leaveGen = (gArmy >= 6) && (gArmy >= 2.2 * threatNear + 6);

  for (var slot = 0; slot < 4; slot++) {
    var bestSc = -1e18;
    var bF = -1, bJ = -1, bDir = 0, bHalf = true, bK = 0;

    for (var mi = 0; mi < myCount; mi++) {
      var fi = myCells[mi];
      if (used[fi]) continue;
      var n = arm[fi];
      if (n < 2) continue;
      if (fi === genIdx && !leaveGen) continue;

      var fx = fi % W;
      var fy = (fi - fx) / W;
      var dMeF = dMe[fi];
      var dGoF = dGoal ? dGoal[fi] : INF;
      /* 目标拉力随距离衰减：只在目标附近形成矛头，远处仍以扩张为主 */
      var goalW = 0;
      if (dGoal && dGoF < INF) {
        goalW = (goalKind === 3) ? 50 : (48 - 4 * dGoF);
        if (goalW < 0) goalW = 0;
      }
      var armyBonus = (n < 50 ? n : 50) * 0.8;

      for (var d = 0; d < 4; d++) {
        var nx = fx + ddx[d];
        var ny = fy + ddy[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var tj = ny * W + nx;
        if (terr[tj] === 1) continue;
        var ot = own[tj];
        if (ot === -2) continue;

        /* ---------- 7a. 增援（自己的格子） ---------- */
        if (ot === me) {
          var scR = -1e17;
          var dMeT = dMe[tj];
          if (dMeT < INF && dMeF < INF) {
            var outward = dMeT - dMeF;
            if (outward > 0) scR = 8 + outward * 10 + armyBonus;
          }
          if (goalW > 0) {
            var dGoT = dGoal[tj];
            if (dGoT < dGoF) {
              var flow = 15 + (dGoF - dGoT) * 12 + armyBonus;
              if (flow > scR) scR = flow;
            }
          }
          if (goalKind === 3 && tj === genIdx) {
            var scD = 8000 + n * 6;
            if (scD > scR) scR = scD;
          }
          /* 没有意义的增援（向内挪兵 / 无目标时横向挪兵）直接丢弃，避免空转占槽位 */
          if (scR <= -1e16) continue;
          if (fresh[tj]) scR -= 40;
          if (scR > bestSc) {
            bestSc = scR;
            bF = fi; bJ = tj; bDir = d;
            bHalf = (fi === genIdx);
            bK = bHalf ? (n >> 1) : (n - 1);
          }
          continue;
        }

        /* ---------- 7b. 队友格：不攻击，也不白送 ---------- */
        if (ot >= 0 && ot < pc && teamOf[ot] === myTeam) continue;

        /* ---------- 7c. 进攻 ---------- */
        var def = arm[tj];
        if (def < 0) continue;
        var kHalf = n >> 1;
        var kFull = n - 1;
        if (kFull <= def) continue;
        var need = def + 1;
        var hiVal = (terr[tj] === 2 || terr[tj] === 3);
        var nearGoal = (goalW > 0 && dGoal[tj] < dGoF);
        var k, half;
        if (fi === genIdx) {
          if (kHalf > def) { k = kHalf; half = true; }
          else { k = kFull; half = false; }
        } else if (nearGoal || hiVal) {
          k = kFull; half = false;
        } else if (kHalf > def) {
          k = kHalf; half = true;
        } else {
          k = kFull; half = false;
        }
        if (k <= def) continue;

        var sc = 100;

        /* 目标项只奖励"靠近"，不惩罚"远离"：避免有目标时其余方向停止扩张 */
        var dGoT2 = dGoal ? dGoal[tj] : INF;
        if (goalW > 0 && dGoT2 < dGoF) sc += (dGoF - dGoT2) * goalW;

        var dMeT2 = dMe[tj];
        if (dMeT2 < INF && dMeF < INF) sc += (dMeT2 - dMeF) * 30;

        if (terr[tj] === 2) sc += 900;
        if (terr[tj] === 3) sc += 60000;
        sc += (ot === -1) ? 40 : 70;

        sc += armyBonus;
        sc -= (k - need) * 0.5;
        if (fresh[tj]) sc -= 50;

        if (sc > bestSc) {
          bestSc = sc;
          bF = fi; bJ = tj; bDir = d; bHalf = half; bK = k;
        }
      }
    }

    if (bF < 0) break;

    var n0 = arm[bF];
    arm[bF] = n0 - bK;
    var oj = own[bJ];
    if (oj === me) {
      arm[bJ] += bK;
    } else {
      var dj = arm[bJ];
      if (bK > dj) {
        own[bJ] = me;
        arm[bJ] = bK - dj;
        myCells[myCount++] = bJ;
      } else {
        arm[bJ] = dj - bK;
      }
    }
    used[bF] = 1;
    fresh[bJ] = 1;

    var mx = bF % W;
    moves.push({ from: { x: mx, y: (bF - mx) / W }, dir: DIRS[bDir], half: bHalf });
  }

  return { moves: moves, memory: mem };
}
