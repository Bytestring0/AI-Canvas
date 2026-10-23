/* =========================================================================
 * 将军棋 (junqi-2) 策略
 * -------------------------------------------------------------------------
 * 设计概要：
 *   1. 用顶层（Worker 内）持久化数组记住"最后一次看到"的 owner / army，
 *      配合 observation.terrain 的永久记忆，重建一张"信念地图"。
 *   2. 每 tick 计算 4~5 张 BFS 距离势场（未知区域 / 城市 / 敌方将军 / 敌方领土
 *      / 己方将军），作为"战略引力"，指导所有移动的取舍。
 *   3. 用"贪心 + 同 tick 模拟"挑选最多 4 条指令：每选一条就把它作用在
 *      内部模拟棋盘上，再基于新棋盘选下一条（天然支持同 tick 连锁推进）。
 *   4. 战斗只在 k > 守军 时才被估值；占领中立空地是"零成本"（军队守恒），
 *      因此永远优先；城市按剩余回合折算收益；敌方将军击杀价值最高。
 *   5. 将军安全：只依据"当前可见"的敌方棋子估计威胁，动态计算守军下限，
 *      不足时把附近的己方部队往将军回流。
 * 纯同步、无随机、无外部依赖、无 DOM / 网络 / Date / Math.random。
 * ========================================================================= */
'use strict';

/* ---------------------------- 可调常量 ------------------------------ */
var MEMV = 4;              // memory 结构版本
var CITY_GUESS = 45;       // 未见过的中立城市默认驻军（40~50 的中值）

var W_LAND        = 20;    // 占领中立空地的基础价值
var W_ENEMY_LAND  = 30;    // 占领敌方土地的基础价值（含"剥夺"意义）
var W_CITY_EXTRA  = 100;   // 从敌人手里夺城的额外价值
var W_KILL        = 6000;  // 攻陷敌方将军
var ARMY_COST     = 1.1;   // 每损失 1 军的代价权重
var W_MOVE        = 0.02;  // 多带兵推进的奖励（顺带用于"大垛优先"的平局决胜）
var MOVE_CAP      = 500;   // 上面这项的封顶
var CHAIN_W       = 7;     // 同一 tick 内继续推进同一支纵队的奖励
var W_VIS         = 2.0;   // 每揭开 1 格迷雾的价值
var MTN_PEN       = 1.2;   // 目标格紧邻已知山地（死路）的惩罚
var UNCERT_PEN    = 2;     // 目标格信息不确定（迷雾外）的惩罚
var THRESH        = 0.5;   // 只有期望收益 > THRESH 才行动
var DEF_W         = 5;     // 将军缺兵时，每输送 1 军回家的价值
var RESERVE_PEN   = 12;    // 把将军兵力压到安全线以下的惩罚系数
var SRC_LIMIT     = 480;   // 参与评估的己方出发点上限（性能护栏）
var INNER_LIMIT   = 220;   // 其中"内陆格"的上限
var AMP_CAP       = 60;    // 攻势放大系数所依据的兵力上限
var AMP_DIV       = 15;    // 攻势放大系数：amp = 1 + min(k,AMP_CAP)/AMP_DIV

/* ---------------------------- 持久化状态 ---------------------------- */
var SW = 0, SH = 0, Sseed = '', Sme = -1, Stick = -1;
var lastOwn = null;   // Int8Array  最后一次看到的 owner（-2 从未见过）
var lastArm = null;   // Int32Array 最后一次看到的 army（-1 未知）
var lastSeen = null;  // Int32Array 最后一次看到的 tick
var genList = null;   // [{i, id}] 已知的将军格

/* ---------------------------- 每 tick 复用缓冲 ---------------------- */
var T = null, OW = null, AR = null, VIS = null, UNK = null, MTN = null;
var QA = null, FU = null, FC = null, FG = null, FE = null, FH = null;
var sOW = null, sAR = null, sUC = null, sCH = null, INS = null;

var DX = [0, 1, 0, -1];
var DY = [-1, 0, 1, 0];
var DN = ['up', 'right', 'down', 'left'];

var PAL = new Uint8Array(64);   // alive
var PTE = new Int16Array(64);   // team
var PAR = new Int32Array(64);   // 公开总军力
var ENEMY = new Uint8Array(64); // 是否为敌对玩家

/* ============================ 基础设施 ============================== */

function ensureState(o, w, h) {
  var fresh = false;
  if (!T || SW !== w || SH !== h || Sseed !== o.seed || Sme !== (o.you.id | 0)) fresh = true;
  else if (Stick < 0 || o.tick === 0 || (o.tick | 0) < Stick) fresh = true;
  if (!fresh) return;

  var n = w * h;
  SW = w; SH = h; Sseed = o.seed; Sme = o.you.id | 0;

  lastOwn  = new Int8Array(n);  lastOwn.fill(-2);
  lastArm  = new Int32Array(n); lastArm.fill(-1);
  lastSeen = new Int32Array(n); lastSeen.fill(-1);

  T = new Int8Array(n); OW = new Int8Array(n); AR = new Int32Array(n);
  VIS = new Uint8Array(n); UNK = new Uint8Array(n); MTN = new Uint8Array(n);
  QA = new Int32Array(n);
  FU = new Int32Array(n); FC = new Int32Array(n); FG = new Int32Array(n);
  FE = new Int32Array(n); FH = new Int32Array(n);
  sOW = new Int8Array(n); sAR = new Int32Array(n); sUC = new Uint8Array(n);
  sCH = new Uint8Array(n); INS = new Uint8Array(n);
  genList = [];

  // 若 Worker 被重建（顶层变量丢失），尽量用 memory 恢复关键知识
  var m = o.memory;
  if (m && m.v === MEMV && m.s === o.seed && m.w === w && m.h === h) {
    var i, a = m.g || [];
    for (i = 0; i + 1 < a.length; i += 2) genList.push({ i: a[i] | 0, id: a[i + 1] | 0 });
    a = m.c || [];
    for (i = 0; i + 1 < a.length; i += 2) {
      var ci = a[i] | 0;
      if (ci >= 0 && ci < n) { lastArm[ci] = a[i + 1] | 0; lastSeen[ci] = m.t | 0; lastOwn[ci] = -1; }
    }
    a = m.e || [];
    for (i = 0; i + 2 < a.length; i += 3) {
      var si = a[i] | 0;
      if (si >= 0 && si < n) { lastOwn[si] = a[i + 1] | 0; lastArm[si] = a[i + 2] | 0; lastSeen[si] = m.t | 0; }
    }
  }
}

/** 迷雾外格子的军力估计：只看"生产"这一确定项，不做任何随机猜测 */
function estArmy(owner, base, dt, terr, g) {
  if (owner < 0) return base;            // 中立（含中立城市）不再增长
  if (base < 0) base = 0;
  if (dt <= 0) return base;
  var add;
  if (terr === 3) add = Math.floor(g * dt * 0.5);        // 将军：常被调兵出去，打折
  else if (terr === 2) add = Math.floor(g * dt * 0.6);   // 城市
  else add = Math.floor(g * dt / 25);                    // 普通土地
  if (add > 250) add = 250;
  return base + add;
}

/** 多源 BFS（4 邻接，山地为墙），写入 out，-1 表示不可达 */
function bfsField(srcs, out) {
  var n = SW * SH, i, s;
  out.fill(-1);
  var head = 0, tail = 0;
  for (i = 0; i < srcs.length; i++) {
    s = srcs[i];
    if (s >= 0 && s < n && out[s] < 0) { out[s] = 0; QA[tail++] = s; }
  }
  while (head < tail) {
    var c = QA[head++];
    var d = out[c] + 1;
    var cx = c % SW, cy = (c - cx) / SW;
    for (var k = 0; k < 4; k++) {
      var nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= SW || ny >= SH) continue;
      var ni = ny * SW + nx;
      if (out[ni] >= 0) continue;
      if (T[ni] === 1) continue;
      out[ni] = d; QA[tail++] = ni;
    }
  }
}

/** 势场下降量：a -> b 靠近目标多少步（不可达按 0 处理） */
function drop(F, a, b) {
  var x = F[a], y = F[b];
  if (x < 0 || y < 0) return 0;
  return x - y;
}

function addCapped(dst, arr, limit) {
  var i;
  if (arr.length <= limit) { for (i = 0; i < arr.length; i++) dst.push(arr[i]); return; }
  var step = arr.length / limit;
  for (i = 0; i < limit; i++) dst.push(arr[(i * step) | 0]);
}

/* ============================ 主流程 ================================ */

function runTurn(o) {
  var W = o.width | 0, H = o.height | 0;
  if (!(W > 0 && H > 0) || !o.you) return { moves: [], memory: null };

  var tick = o.tick | 0;
  ensureState(o, W, H);
  var n = W * H;
  var me = o.you.id | 0, myTeam = o.you.team | 0;
  var maxTicks = o.maxTicks | 0;
  var remaining = maxTicks - tick; if (!(remaining > 0)) remaining = 1;
  var g = 1 + Math.floor(tick / 200);

  /* ---------- 玩家表 ---------- */
  var cap = 64, i, k, p;
  PAL.fill(0); PAR.fill(0);
  for (i = 0; i < cap; i++) PTE[i] = -1;
  var pl = o.players || [];
  for (i = 0; i < pl.length; i++) {
    p = pl[i]; if (!p) continue;
    var pid = p.id | 0;
    if (pid >= 0 && pid < cap) { PAL[pid] = p.alive ? 1 : 0; PAR[pid] = p.army | 0; PTE[pid] = p.team | 0; }
  }
  PAL[me] = (o.you.alive === false) ? 0 : 1;
  PTE[me] = myTeam;

  var teamMode = false;
  for (i = 0; i < cap; i++) if (i !== me && PAL[i] && PTE[i] === myTeam) teamMode = true;
  ENEMY.fill(0);
  for (i = 0; i < cap; i++) {
    if (i === me || !PAL[i]) continue;
    if (teamMode && PTE[i] === myTeam) continue;
    ENEMY[i] = 1;
  }

  if (!o.you.alive) { Stick = tick; return { moves: [], memory: buildMem(o, n) }; }

  /* ---------- 信念地图 ---------- */
  var myArmy = 0;
  for (var y = 0; y < H; y++) {
    var trow = o.terrain[y], orow = o.owner[y], arow = o.army[y];
    var base = y * W;
    for (var x = 0; x < W; x++) {
      i = base + x;
      var tt = (trow && trow[x] !== undefined) ? (trow[x] | 0) : -1;
      var ow = (orow && orow[x] !== undefined) ? (orow[x] | 0) : -2;
      var ar = (arow && arow[x] !== undefined) ? (arow[x] | 0) : -1;
      T[i] = tt;
      if (ow !== -2 && ar >= 0) {                 // 当前可见：刷新记忆
        VIS[i] = 1;
        lastOwn[i] = ow; lastArm[i] = ar; lastSeen[i] = tick;
        OW[i] = ow; AR[i] = ar;
        if (ow === me) myArmy += ar;
      } else {                                    // 迷雾外：用记忆 + 生产推断
        VIS[i] = 0;
        var lo = lastOwn[i];
        if (lo === -2) {                          // 从未见过
          OW[i] = -1;
          AR[i] = (tt === 2) ? CITY_GUESS : 0;
        } else {
          OW[i] = lo;
          var e = estArmy(lo, lastArm[i], tick - lastSeen[i], tt, g);
          if (lo >= 0 && PAR[lo] > 0 && e > PAR[lo]) e = PAR[lo];   // 单格不可能超过其总军力
          AR[i] = e;
        }
      }
    }
  }

  /* ---------- 邻域统计：迷雾收益 / 死路惩罚 ---------- */
  UNK.fill(0); MTN.fill(0);
  for (y = 0; y < H; y++) {
    for (x = 0; x < W; x++) {
      var c = y * W + x, ct = T[c];
      if (ct !== -1 && ct !== 1) continue;
      var isUnk = (ct === -1) ? 1 : 0;
      for (var dy = -1; dy <= 1; dy++) {
        var ay = y + dy; if (ay < 0 || ay >= H) continue;
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var ax = x + dx; if (ax < 0 || ax >= W) continue;
          var ai = ay * W + ax;
          if (isUnk) UNK[ai]++; else MTN[ai]++;
        }
      }
    }
  }

  /* ---------- 将军位置与"已知敌方将军"维护 ---------- */
  var gi = -1, ownGen = -1;
  if (o.you.general) {
    var gx = o.you.general.x | 0, gy = o.you.general.y | 0;
    if (gx >= 0 && gx < W && gy >= 0 && gy < H) gi = gy * W + gx;
  }
  for (i = 0; i < n; i++) {
    if (T[i] !== 3) continue;
    var ow2 = OW[i];
    if (ow2 === me) { if (ownGen < 0) ownGen = i; continue; }
    if (VIS[i] && ow2 >= 0 && ow2 !== me) {
      var found = -1;
      for (k = 0; k < genList.length; k++) if (genList[k].i === i) { found = k; break; }
      if (found >= 0) genList[found].id = ow2;
      else genList.push({ i: i, id: ow2 });
    }
  }
  if (gi < 0 || T[gi] !== 3) gi = ownGen;          // 兜底：用地形 3 且属于自己的格子

  var ng = [];
  for (k = 0; k < genList.length; k++) if (T[genList[k].i] === 3) ng.push(genList[k]);
  genList = ng;

  /* ---------- 敌我实力概览（后面的守军下限与权重都要用） ---------- */
  var maxE = 0, anyE = false;
  for (i = 0; i < cap; i++) if (ENEMY[i] && PAL[i]) { anyE = true; if (PAR[i] > maxE) maxE = PAR[i]; }

  /* ---------- 先算"到我方将军"的距离场：既用于回防，也用于反推敌方将军方位 ---------- */
  if (gi >= 0) bfsField([gi], FH); else FH.fill(-1);

  /* ---------- 势场目标 ---------- */
  var citySrc = [], unkSrc = [], enemySrc = [], genSrc = [];
  for (i = 0; i < n; i++) {
    var tt2 = T[i];
    if (tt2 === 1) continue;
    if (tt2 === -1) { unkSrc.push(i); continue; }
    var ow3 = OW[i];
    if (tt2 === 2 && ow3 !== me && !(ow3 >= 0 && !ENEMY[ow3])) citySrc.push(i);
    if (ow3 >= 0 && ENEMY[ow3]) enemySrc.push(i);
  }
  /* 已知敌方将军 */
  var haveGen = new Uint8Array(cap);
  for (k = 0; k < genList.length; k++) {
    if (ENEMY[genList[k].id]) { genSrc.push(genList[k].i); haveGen[genList[k].id] = 1; }
  }
  /* 未见过的敌方将军：将军彼此远离，故"离我方将军最远的已知敌格"是最可疑的位置 */
  var sBestI = new Int32Array(cap), sBestD = new Int32Array(cap);
  for (i = 0; i < cap; i++) { sBestI[i] = -1; sBestD[i] = -1; }
  for (i = 0; i < n; i++) {
    var oe = OW[i];
    if (!(oe >= 0 && ENEMY[oe])) continue;
    var dv = FH[i]; if (dv < 0) dv = 0;
    if (dv > sBestD[oe]) { sBestD[oe] = dv; sBestI[oe] = i; }
  }
  for (i = 0; i < cap; i++) {
    if (ENEMY[i] && !haveGen[i] && sBestI[i] >= 0) genSrc.push(sBestI[i]);
  }

  bfsField(unkSrc, FU);
  bfsField(citySrc, FC);
  bfsField(genSrc, FG);
  bfsField(enemySrc, FE);

  /* ---------- 将军守军下限 ----------
     侦察半径 3 步（提前一拍预警）；迷雾外的敌情按 0.6 折计算，
     既不无视潜在威胁，也不会被过期的记忆吓得全员回防。 */
  var need = 1, minED = -1;                        // minED：最近的已知敌方格到我将军的距离
  if (gi >= 0) {
    for (i = 0; i < n; i++) {
      var oe = OW[i];
      if (!(oe >= 0 && ENEMY[oe])) continue;
      var d = FH[i]; if (d < 0) continue;
      if (minED < 0 || d < minED) minED = d;
      if (d > 3) continue;
      var estA = AR[i];
      if (!VIS[i]) estA = estA * 0.6;
      var arrive = estA - d;                       // 敌方最多能送到的兵力（每步 -1）
      if (arrive + 1 > need) need = arrive + 1;
    }
  }
  /* 基础守军：只有当敌人已经出现在附近时才留守；无人临近就全力扩张。
     否则早期将军会被"守军下限"卡住，白白拖慢开局。 */
  var base = 1;
  if (minED >= 0 && minED <= 10) {
    base = 6;
    if (myArmy > 800) base = 12;
    if (myArmy > 5000) base = 20;
  }
  if (need < base) need = base;

  /* ---------- 阶段权重 ---------- */
  var WU  = tick < 120 ? 1.8 : 1.2;   // 探索
  var WC  = remaining > 60 ? 2.2 : 0.0;                    // 城市（快结束了就不值得砸兵）
  /* 猎杀权重：实力越悬殊，越该把 4 条指令用于奔袭敌将而不是捡地 */
  var WG  = 2.2;
  var agg = (!anyE) || (myArmy >= maxE * 1.1);
  var WE  = agg ? 1.2 : 0.5;
  if (genSrc.length) {
    if (myArmy >= maxE * 2) { WG = 6.5; WE = 2.0; }        // 碾压：优先清场（胜利分远大于捡地分）
    else if (myArmy >= maxE * 1.3) { WG = 4.0; WE = 1.5; }
  }
  if (remaining < 120 && myArmy < maxE) WE = 1.6;          // 落后且快结束：必须抢军力/领土
  if (remaining < 25) { WG = 1.0; }                        // 收官：来不及奔袭就专心抢地抢兵
  var WCE = 0.25;                                          // 向地图中心靠拢（更容易碰到城市与敌人）

  /* 清场模式：实力碾压且还有敌人时，"再捡一格地"的边际收益远低于"多杀一个将"，
     因此主动压低扩张/探索的估值，把 4 条指令让给奔袭。 */
  var hunt = (genSrc.length > 0 && anyE && myArmy >= maxE * 2 && remaining > 25) ? 1 : 0;
  var landW = hunt ? W_LAND * 0.30 : W_LAND;
  var visW  = hunt ? W_VIS * 0.40 : W_VIS;
  if (hunt) WU = WU * 0.4;
  var cityVal = Math.min(remaining, 600) * g * 0.4;        // 城市按剩余回合折现

  var cx0 = (W - 1) * 0.5, cy0 = (H - 1) * 0.5;

  /* ---------- 候选出发点 ---------- */
  /* 候选出发点 = 兵力最大的若干格（负责长途奔袭/集结）
                + 前线格（负责贴边扩张），两者都做等距抽样以覆盖全图 */
  var cand = [], frontier = [];
  for (i = 0; i < n; i++) {
    if (OW[i] !== me) continue;
    var a0 = AR[i];
    if (a0 < 2) continue;
    cand.push(i);
    var fx0 = i % W, fy0 = (i - fx0) / W;
    for (k = 0; k < 4; k++) {
      var nx0 = fx0 + DX[k], ny0 = fy0 + DY[k];
      if (nx0 < 0 || ny0 < 0 || nx0 >= W || ny0 >= H) continue;
      var ni0 = ny0 * W + nx0;
      if (T[ni0] === 1) continue;
      if (OW[ni0] !== me) { frontier.push(i); break; }
    }
  }
  var srcs;
  if (cand.length <= SRC_LIMIT + INNER_LIMIT) {
    srcs = cand;
  } else {
    var byArmy = cand.slice().sort(function (a, b) { return AR[b] - AR[a]; });
    srcs = byArmy.slice(0, SRC_LIMIT);
    addCapped(srcs, frontier, INNER_LIMIT);
    if (gi >= 0 && AR[gi] >= 2 && srcs.indexOf(gi) < 0) srcs.push(gi);
  }
  INS.fill(0);
  for (i = 0; i < srcs.length; i++) INS[srcs[i]] = 1;

  /* ---------- 贪心 + 同 tick 模拟 ---------- */
  sOW.set(OW); sAR.set(AR); sUC.fill(0); sCH.fill(0);
  var moves = [];

  for (var step = 0; step < 4; step++) {
    var bestV = THRESH, bestF = -1, bestT = -1, bestD = -1, bestM = 0, bestK = 0, bestDef = 0, bestUnc = 0;
    var deficit = 0;
    if (gi >= 0 && need > 0) { deficit = need - sAR[gi]; if (deficit < 0) deficit = 0; }

    for (var s = 0; s < srcs.length; s++) {
      var f = srcs[s];
      if (sUC[f]) continue;                 // 不从来路不明的格子继续推进
      if (sOW[f] !== me) continue;
      var nf = sAR[f]; if (nf < 2) continue;
      var fx = f % W, fy = (f - fx) / W;
      var cdf = Math.abs(fx - cx0) + Math.abs(fy - cy0);

      for (var d2 = 0; d2 < 4; d2++) {
        var tx = fx + DX[d2], ty = fy + DY[d2];
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        var t2 = ty * W + tx;
        var tt3 = T[t2];
        if (tt3 === 1) continue;                       // 已知山地
        var to = sOW[t2];
        if (to >= 0 && to !== me && !ENEMY[to]) continue;  // 不主动送兵给队友

        var enemyT = (to >= 0 && to !== me) ? 1 : 0;
        var unc = (tt3 === -1 || !VIS[t2]) ? 1 : 0;
        var defA = sAR[t2]; if (defA < 0) defA = 0;

        /* 两种势能：
           flowX = 探索 / 城市 / 向地图中心（扩张型，人人适用）
           flowE = 压向敌方将军与敌方领土（攻势型：兵力越多，越该由大垛来走）*/
        var flowX = WU * drop(FU, f, t2) + WC * drop(FC, f, t2)
                  + WCE * (cdf - (Math.abs(tx - cx0) + Math.abs(ty - cy0)));
        var flowE = WG * drop(FG, f, t2) + WE * drop(FE, f, t2);

        var cdt = UNK[t2];
        var mtn = MTN[t2];

        for (var mi = 0; mi < 2; mi++) {               // mi=0: half, mi=1: 全军出击
          var kk2 = mi === 0 ? (nf >> 1) : (nf - 1);
          if (kk2 < 1) continue;
          var amp = 1 + (kk2 > AMP_CAP ? AMP_CAP : kk2) / AMP_DIV;
          var prog = flowX + flowE * amp;
          var val = 0;

          if (to === me) {
            /* 内部调动：只有确实"在往目标走"或在回防时才值得 */
            var defBonus = 0;
            if (gi >= 0 && deficit > 0 && drop(FH, f, t2) > 0) {
              var deliver = kk2 < deficit ? kk2 : deficit;
              defBonus = DEF_W * deliver * (t2 === gi ? 2 : 1);
            }
            if (prog <= 0 && defBonus === 0) continue;
            val = prog + defBonus + (prog > 0 ? W_MOVE * (kk2 > MOVE_CAP ? MOVE_CAP : kk2) : 0);
          } else {
            /* 战斗：必须严格 k > 守军 */
            if (!(kk2 > defA)) continue;
            var gain, costW = ARMY_COST;
            if (enemyT) {
              /* 消耗战代价取决于实力对比：碾压对手时军队是廉价资源，劣势时要惜兵 */
              var rt = PAR[to] > 0 ? myArmy / PAR[to] : 4;
              if (rt >= 3) costW = 0.45;
              else if (rt >= 1.5) costW = 0.7;
              else if (rt < 0.6) costW = 1.6;
            }
            if (enemyT && tt3 === 3) gain = W_KILL;
            else if (tt3 === 2) gain = cityVal + (enemyT ? W_CITY_EXTRA : 0);
            else if (enemyT) gain = W_ENEMY_LAND + (myArmy >= PAR[to] ? 0.9 : 0.15) * defA;
            else gain = landW;
            val = gain - costW * defA + prog
                + W_MOVE * (kk2 > MOVE_CAP ? MOVE_CAP : kk2)
                + visW * cdt - MTN_PEN * mtn;
          }

          if (f === gi && need > 0 && (nf - kk2) < need) val -= RESERVE_PEN * (need - (nf - kk2));
          if (unc) val -= UNCERT_PEN;
          if (sCH[f]) val += CHAIN_W;   // 让同一支纵队在本 tick 内走满 4 步，而不是 4 支各走 1 步

          if (val > bestV) {
            bestV = val; bestF = f; bestT = t2; bestD = d2; bestM = mi;
            bestK = kk2; bestDef = defA; bestUnc = unc;
          }
        }
      }
    }

    if (bestF < 0) break;

    /* 作用到模拟棋盘 */
    sAR[bestF] -= bestK;
    if (sOW[bestT] === me) {
      sAR[bestT] += bestK;
    } else {
      sAR[bestT] = bestK - bestDef;
      sOW[bestT] = me;
    }
    if (bestUnc) sUC[bestT] = 1;
    sCH[bestT] = 1;
    if (!INS[bestT] && sAR[bestT] >= 2 && !sUC[bestT]) { INS[bestT] = 1; srcs.push(bestT); }

    moves.push({
      from: { x: bestF % W, y: (bestF - (bestF % W)) / W },
      dir: DN[bestD],
      half: bestM === 0
    });
  }

  Stick = tick;
  return { moves: moves, memory: buildMem(o, n) };
}

function buildMem(o, n) {
  var m = { v: MEMV, s: o.seed, w: SW, h: SH, t: o.tick | 0, g: [], c: [], e: [] };
  var i;
  for (i = 0; i < genList.length; i++) m.g.push(genList[i].i | 0, genList[i].id | 0);
  var cnt = 0;
  for (i = 0; i < n && cnt < 220; i++) {
    if (T[i] === 2 && lastSeen[i] >= 0) { m.c.push(i, lastArm[i] | 0); cnt++; }
  }
  cnt = 0;
  /* 只记敌方格（我方格的归属每 tick 都能直接看到，不占预算） */
  for (i = 0; i < n && cnt < 420; i++) {
    if (lastOwn[i] >= 0 && lastOwn[i] !== Sme && lastSeen[i] >= 0) {
      m.e.push(i, lastOwn[i] | 0, lastArm[i] | 0); cnt++;
    }
  }
  return m;
}

/* ============================ 对外入口 ============================== */

function decide(observation) {
  var res;
  try {
    res = runTurn(observation);
  } catch (err) {
    res = { moves: [], memory: (observation && observation.memory) ? observation.memory : null };
  }
  if (!res || typeof res !== 'object') res = { moves: [], memory: null };
  if (!Array.isArray(res.moves)) res.moves = [];

  // 出口校验：绝不让格式错误导致出局
  var out = [];
  for (var i = 0; i < res.moves.length && out.length < 4; i++) {
    var mv = res.moves[i];
    if (!mv || !mv.from) continue;
    var x = mv.from.x | 0, y = mv.from.y | 0;
    if (x !== mv.from.x || y !== mv.from.y) continue;
    if (!isFinite(x) || !isFinite(y)) continue;
    var dir = mv.dir;
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') continue;
    var half = (mv.half === false) ? false : true;
    out.push({ from: { x: x, y: y }, dir: dir, half: half });
  }
  return { moves: out, memory: res.memory === undefined ? null : res.memory };
}
