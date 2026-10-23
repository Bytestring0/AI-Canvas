/* =====================================================================
 *  将军棋 AI 策略 —— 协议 junqi-2
 *  纯 JavaScript（ES5/ES2015 语法），无 import / export / 第三方依赖，
 *  不访问网络、DOM、存储，不使用 Date / Math.random 等非确定性输入。
 *
 *  入口：decide(observation) -> { moves: Move[], memory: any }
 *
 *  设计要点（详见 README.md）：
 *   1) 迷雾记忆：地形常驻 observation.terrain，长期信息（将军/城市归属与
 *      驻军估值、当前进攻目标）存进 memory。
 *   2) 贪心 + 模拟：每个 tick 最多 4 条指令，逐条在本地模拟棋盘上结算，
 *      因此可以同 tick 内连续冲锋（甲→乙→丙）。
 *   3) 分阶段：扩张期优先开图占地，中期打便宜地，后期集中兵力斩将。
 *   4) 全部决策只依赖 observation 内容，完全确定性可复现。
 *
 *  工程约定：
 *   - 全部实现收在 IIFE 里，热路径只访问闭包变量与局部变量，不做全局查找。
 *   - 棋盘 / 派生量 / 候选表使用复用的 TypedArray 工作区，避免每 tick 产生
 *     大量临时对象导致 GC 抖动。
 * ===================================================================== */

function decide(o) {
  try {
    return __mavisRun(o);
  } catch (e) {
    // 任何异常都不允许导致出局：待命并保留原有记忆
    var keep = (o && o.memory && typeof o.memory === 'object') ? o.memory : null;
    return { moves: [], memory: keep };
  }
}

var __mavisRun = (function () {
  'use strict';

  var MTN     = 1;   // 山地
  var CITY_T  = 2;   // 城市
  var GEN_T   = 3;   // 将军
  var TUNK    = -1;  // 未侦察地形
  var OWN_UNK = -2;  // 视野外（归属未知）
  var OWN_NEU = -1;  // 中立

  var KIND_ATTACK = 0, KIND_REINF = 1, KIND_EXPAND = 2;

  /* ---- 复用的工作区（按地图尺寸缓存），避免每 tick 分配 ---- */
  var ws = { n: -1 };

  function getWorkspace(N) {
    if (ws.n === N) return ws;
    ws.n = N;
    var cap = 4 * N + 8;
    ws.terrain = new Int8Array(N);
    ws.own = new Int16Array(N);
    ws.arm = new Int32Array(N);
    ws.friendOf = new Uint8Array(N);
    ws.enemyOf = new Uint8Array(N);
    ws.adjEnemy = new Int32Array(N);
    ws.adjUnk = new Int8Array(N);
    ws.adjGen = new Uint8Array(N);
    ws.frontier = new Uint8Array(N);
    ws.prio = new Uint8Array(N);
    ws.specialDef = new Int32Array(N);
    ws.dirty = new Uint8Array(N);
    ws.floor = new Uint8Array(N);
    ws.cFi = new Int32Array(cap);
    ws.cTi = new Int32Array(cap);
    ws.cD = new Int8Array(cap);
    ws.cKind = new Int8Array(cap);
    ws.cScore = new Float64Array(cap);
    ws.bfsDist = new Int32Array(N);
    ws.bfsDist2 = new Int32Array(N);
    ws.bfsQueue = new Int32Array(N);
    ws.myCells = new Int32Array(N);
    ws.touched = new Int32Array(64);
    return ws;
  }

  /* =================================================================
   * 主流程
   * =============================================================== */
  function runStrategy(o) {
    var W = o.width | 0, H = o.height | 0, N = W * H;
    var myId = o.you.id, myTeam = o.you.team;
    var tick = o.tick | 0, maxTicks = o.maxTicks | 0;
    var x, y, idx, i;

    var terrG = o.terrain, ownG = o.owner, armyG = o.army;
    var W2 = getWorkspace(N);
    var terrain = W2.terrain, own = W2.own, arm = W2.arm;
    var friendOf = W2.friendOf, enemyOf = W2.enemyOf;

    /* ---------- 读入棋盘（扁平化，后续全部用整数索引） ---------- */
    for (y = 0; y < H; y++) {
      var row = y * W;
      var tRow = terrG[y], oRow = ownG[y], aRow = armyG[y];
      for (x = 0; x < W; x++) {
        idx = row + x;
        var tv = tRow[x];
        terrain[idx] = (typeof tv === 'number') ? tv : TUNK;
        var ov = oRow[x];
        own[idx] = (typeof ov === 'number') ? ov : OWN_UNK;
        var av = aRow[x];
        arm[idx] = (typeof av === 'number' && isFinite(av)) ? av : -1;
      }
    }

    /* ---------- 记忆 ---------- */
    var mem = (o.memory && typeof o.memory === 'object' && !Array.isArray(o.memory)) ? o.memory : {};
    var genInfo  = (mem.genInfo  && typeof mem.genInfo  === 'object') ? mem.genInfo  : {};
    var cityInfo = (mem.cityInfo && typeof mem.cityInfo === 'object') ? mem.cityInfo : {};
    var enemySeen = (mem.enemySeen && typeof mem.enemySeen === 'object') ? mem.enemySeen : {};
    var enemyList = (mem.enemyList && typeof mem.enemyList === 'object' && mem.enemyList instanceof Array) ? mem.enemyList : [];
    var assault  = (mem.assault  && typeof mem.assault  === 'object') ? mem.assault  : null;

    /* 队伍表：判断同队 */
    var players = o.players || [];
    var pcount = players.length;
    var teamArr = new Int16Array(pcount + 2);
    for (i = 0; i < pcount + 2; i++) teamArr[i] = -1;
    for (i = 0; i < pcount; i++) {
      var tval = players[i].team;
      teamArr[players[i].id] = (typeof tval === 'number') ? tval : -1;
    }
    var myTeamLocal = myTeam;

    /* 把本 tick 看得见的将军 / 城市 / 敌方占格记下来 */
    var genCount = 0, cityCount = 0;
    for (idx = 0; idx < N; idx++) {
      var oi = own[idx];
      if (oi === OWN_UNK) continue;
      var tt = terrain[idx];
      var isEnemyCell = (oi >= 0 && oi !== myId &&
                         !(oi < teamArr.length && teamArr[oi] === myTeamLocal));
      if (tt === GEN_T || tt === CITY_T) {
        var key = '' + idx;                 /* 只在将军/城市格上建 key，避免每格拼字符串 */
        if (tt === GEN_T) {
          if (oi !== myId) { if (!genInfo[key]) genCount++; genInfo[key] = { id: oi, a: arm[idx], t: tick }; }
          if (cityInfo[key]) { delete cityInfo[key]; cityCount--; }
        } else {
          if (!cityInfo[key]) cityCount++;
          cityInfo[key] = { id: oi, a: arm[idx], t: tick };
          if (genInfo[key]) { delete genInfo[key]; genCount--; }
        }
      } else if (isEnemyCell) {
        var ekey = '' + idx;
        if (!enemySeen[ekey]) { enemySeen[ekey] = 1; enemyList.push(idx); }
      }
    }
    if (genCount > 400) { pruneMem(genInfo); genCount = 0; }
    if (cityCount > 400) { pruneMem(cityInfo); cityCount = 0; }
    if (enemyList.length > 320) {
      var drop = enemyList.splice(0, 40);
      for (i = 0; i < drop.length; i++) delete enemySeen['' + drop[i]];
    }

    /* ---------- 上下文 ---------- */
    var ctx = {
      W: W, H: H, N: N,
      terrain: terrain, own: own, arm: arm,
      myId: myId, myTeam: myTeam, teamArr: teamArr,
      tick: tick, maxTicks: maxTicks,
      genInfo: genInfo, cityInfo: cityInfo, enemySeen: enemySeen, enemyList: enemyList,
      friendOf: friendOf, enemyOf: enemyOf,
      adjEnemy: W2.adjEnemy, adjUnk: W2.adjUnk, adjGen: W2.adjGen,
      frontier: W2.frontier, prio: W2.prio, specialDef: W2.specialDef, dirty: W2.dirty, floor: W2.floor,
      cFi: W2.cFi, cTi: W2.cTi, cD: W2.cD, cKind: W2.cKind, cScore: W2.cScore,
      distTarget: null, target: null, assault: assault,
      myArmyTotal: 0, phase: 0, attackFactor: 0.4, towardW: 0,
      expCap: 99, defending: false, distDef: null, defendBonus: 0, threatNear: 0
    };

    if (!o.you || o.you.alive === false) {
      return { moves: [], memory: packMem(ctx) };
    }

    /* ---------- 敌我判定（扁平数组，热路径里不再做闭包调用） ---------- */
    friendOf.fill(0);
    enemyOf.fill(0);
    for (idx = 0; idx < N; idx++) {
      var oj = own[idx];
      if (oj >= 0) {
        if (oj === myId || (oj < teamArr.length && teamArr[oj] === myTeam)) friendOf[idx] = 1;
        else enemyOf[idx] = 1;
      }
    }

    /* ---------- 己方统计 ---------- */
    var myCells = W2.myCells;
    var nMy = 0;
    var myArmyTotal = 0;
    for (idx = 0; idx < N; idx++) {
      if (own[idx] === myId) {
        myCells[nMy++] = idx;
        myArmyTotal += arm[idx] > 0 ? arm[idx] : 0;
      }
    }
    ctx.myCells = myCells;
    ctx.nMy = nMy;
    ctx.myArmyTotal = myArmyTotal;

    /* ---------- 己方将军位置 ---------- */
    var myGenIdx = -1;
    for (i = 0; i < nMy; i++) {
      if (terrain[myCells[i]] === GEN_T) { myGenIdx = myCells[i]; break; }
    }
    ctx.myGenIdx = myGenIdx;

    /* ---------- 敌方将军列表（地形常驻 ⇒ 见过就记得位置） ---------- */
    var gens = [];
    for (idx = 0; idx < N; idx++) {
      if (terrain[idx] !== GEN_T) continue;
      if (own[idx] === myId) continue;
      var gid = own[idx];
      if (gid === OWN_UNK) {
        var rec = genInfo['' + idx];
        if (rec) gid = rec.id;
      }
      if (gid === myId) continue;
      gens.push({ idx: idx, id: gid, def: estimateDef(ctx, idx) });
    }
    ctx.gens = gens;

    /* ---------- 距离场 ---------- */
    var distMe = bfsFrom(terrain, W, H, myCells, nMy);
    ctx.distMe = distMe;

    /* ---------- 选择进攻目标（敌方将军），带承诺机制 ---------- */
    var target = null, nearest = null, nd = Infinity;
    if (assault && typeof assault.idx === 'number') {
      for (i = 0; i < gens.length; i++) if (gens[i].idx === assault.idx) target = gens[i];
    }
    for (i = 0; i < gens.length; i++) {
      var d = distMe[gens[i].idx];
      if (d < 0) d = 1000000000;
      if (d < nd) { nd = d; nearest = gens[i]; }
    }
    if (target) {
      var dt = distMe[target.idx]; if (dt < 0) dt = 1000000000;
      if (nearest && nearest.idx !== target.idx && nd + 6 < dt) target = nearest;
    } else {
      target = nearest;
    }
    if (target) {
      assault = { idx: target.idx, until: tick + 240 };
    } else if (assault && tick > (assault.until || 0)) {
      assault = null;
    }
    ctx.target = target;
    ctx.assault = assault;

    /* ---------- 中立城市：一座城在整局里能产出的兵力极其可观，
       所以"离我最近的还没被占的中立城"是最高优先级的推进目标 ---------- */
    var bestCity = -1, bestCityD = Infinity;
    for (idx = 0; idx < N; idx++) {
      if (terrain[idx] !== CITY_T) continue;
      if (own[idx] === myId) continue;
      var isNeu = (own[idx] === OWN_NEU);
      if (!isNeu && own[idx] === OWN_UNK) {
        var crec = cityInfo['' + idx];
        isNeu = crec ? (crec.id === OWN_NEU || crec.id < 0) : true;
      }
      if (!isNeu) continue;
      var cd = distMe[idx];
      if (cd < 0) cd = 1000000000;
      if (cd < bestCityD) { bestCityD = cd; bestCity = idx; }
    }
    ctx.bestCity = bestCity;

    /* ---------- 猎杀模式：还没摸到敌方将军时，用见过的敌方占格质心
       推测其首都方位，朝那个方向推进（顺带把战斗往敌境深处打） ---------- */
    var enemyCount = pcount > 1 ? pcount - 1 : 1;
    var allowHunt = (enemyCount <= 4);      /* 敌人越多，一次击杀越不值钱，不宜死磕斩将 */
    var huntIdx = -1;
    if (!target && bestCity < 0 && allowHunt) {
      var eN = enemyList.length;
      if (eN >= 6) {
        var sx = 0, sy = 0;
        for (i = 0; i < eN; i++) {
          var ei = enemyList[i];
          sx += ei % W;
          sy += (ei / W) | 0;
        }
        var ccx = sx / eN, ccy = sy / eN;
        var bestSq = Infinity;
        for (i = 0; i < eN; i++) {
          var ej = enemyList[i];
          var ex = ej % W, ey = (ej / W) | 0;
          var ddx = ex - ccx, ddy = ey - ccy;
          var sq = ddx * ddx + ddy * ddy;
          if (sq < bestSq) { bestSq = sq; huntIdx = ej; }
        }
      }
    }
    ctx.huntIdx = huntIdx;

    /* ---------- 焦点：决定"往哪推兵" ----------
       敌将（连带其领土与击杀分）≈ 2.5 座城；城更近时先抢城。 */
    var focusIdx = -1, focusKind = 0;
    if (target) { focusIdx = target.idx; focusKind = 1; }
    if (bestCity >= 0) {
      var dGen = (focusIdx >= 0) ? distMe[focusIdx] : 1000000000;
      if (dGen < 0) dGen = 1000000000;
      if (dCity2(bestCityD) < dGen) { focusIdx = bestCity; focusKind = 2; }
      else if (focusIdx < 0) { focusIdx = bestCity; focusKind = 2; }
    }
    if (focusIdx < 0 && huntIdx >= 0) { focusIdx = huntIdx; focusKind = 3; }
    ctx.focusIdx = focusIdx;
    ctx.focusKind = focusKind;
    ctx.distTarget = (focusIdx >= 0) ? bfsFrom(terrain, W, H, [focusIdx], undefined, true) : null;

    /* ---------- 阶段 ---------- */
    var phase = 0;
    if (tick > 70 && myArmyTotal >= 45) phase = 1;
    if (tick > maxTicks * 0.45) phase = 2;
    ctx.phase = phase;
    ctx.attackFactor = phase === 0 ? 1.0 : (phase === 1 ? 1.2 : 1.5);
    /* 集结（往焦点推兵）只在两种情况下开启：
       ① 焦点已经不远（≤12 格），走过去代价可控；
       ② 场上人少，斩将/抢城收益高，值得集中兵力。
       否则全队去长途奔袭会白白丢掉沿途的产能与地产。 */
    var focusDist = (focusIdx >= 0) ? distMe[focusIdx] : 1000000000;
    if (focusDist < 0) focusDist = 1000000000;
    var canMarch = (focusIdx >= 0) && (focusDist <= 12 || enemyCount <= 4);
    ctx.towardW = 0;
    if (canMarch && myArmyTotal >= 55) ctx.towardW = 300;
    if (canMarch && myArmyTotal >= 110) ctx.towardW = 380;

    /* ---------- 辅助数组 ---------- */
    var adjEnemy = W2.adjEnemy, adjUnk = W2.adjUnk, adjGen = W2.adjGen;
    var frontier = W2.frontier, prio = W2.prio, specialDef = W2.specialDef, dirty = W2.dirty;
    var floor = W2.floor;

    specialDef.fill(0);
    prio.fill(0);
    dirty.fill(0);
    for (idx = 0; idx < N; idx++) {
      var tvv = terrain[idx];
      if (tvv === GEN_T || tvv === CITY_T) specialDef[idx] = estimateDef(ctx, idx);
    }
    for (idx = 0; idx < N; idx++) refreshCell(ctx, idx);

    /* 我方将军 / 城市周边的敌方格子 → 优先打击 */
    var D8X = [1, -1, 0, 0, 1, 1, -1, -1], D8Y = [0, 0, 1, -1, 1, -1, 1, -1];
    /* ---------- 家门威胁评估：将军周边 3 格内有敌军 ⇒ 加厚卫戍并回防 ---------- */
    var threatNear = 0, enemyNearDist = 99;
    if (myGenIdx >= 0) {
      var gx0 = myGenIdx % W, gy0 = (myGenIdx / W) | 0;
      for (var ty0 = gy0 - 3; ty0 <= gy0 + 3; ty0++) {
        if (ty0 < 0 || ty0 >= H) continue;
        for (var tx0 = gx0 - 3; tx0 <= gx0 + 3; tx0++) {
          if (tx0 < 0 || tx0 >= W) continue;
          var ti0 = ty0 * W + tx0;
          if (!enemyOf[ti0]) continue;
          var ea0 = arm[ti0];
          if (ea0 > threatNear) threatNear = ea0;
          var dd0 = Math.max(Math.abs(tx0 - gx0), Math.abs(ty0 - gy0));
          if (dd0 < enemyNearDist) enemyNearDist = dd0;
        }
      }
    }
    ctx.threatNear = threatNear;
    /* 只有"敌人堆得比我家将军的卫戍还厚"才算真危险，
       否则贸然回防只会白白放弃进攻节奏。 */
    var genGarrison = (myGenIdx >= 0 && arm[myGenIdx] > 0) ? arm[myGenIdx] : 0;
    var defending = (myGenIdx >= 0 && threatNear >= 3 && threatNear > genGarrison);
    ctx.defending = defending;
    ctx.distDef = defending ? bfsFrom(terrain, W, H, [myGenIdx], undefined, true) : null;
    ctx.defendBonus = Math.min(800, 200 + threatNear * 60);

    /* 留兵底线：普通格不设限；城市/将军留底防被偷袭 */
    floor.fill(0);
    for (i = 0; i < nMy; i++) {
      var ci = myCells[i];
      var ct = terrain[ci];
      if (ct === GEN_T) { floor[ci] = 3; continue; }
      if (ct === CITY_T) { floor[ci] = 3; continue; }
      if (ct !== GEN_T && ct !== CITY_T) continue;
      var kx = ci % W, ky = (ci / W) | 0;
      for (var d2 = 0; d2 < 8; d2++) {
        var nx2 = kx + D8X[d2], ny2 = ky + D8Y[d2];
        if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
        var ni2 = ny2 * W + nx2;
        if (enemyOf[ni2]) prio[ni2] = 1;
      }
    }

    /* ---------- 候选 + 逐条模拟执行 ---------- */
    var DIRN = ['up', 'right', 'down', 'left'];
    var cFi = W2.cFi, cTi = W2.cTi, cD = W2.cD, cKind = W2.cKind, cScore = W2.cScore;

    var nCand = buildCandidates(ctx);
    var moves = [];

    for (var step = 0; step < 4; step++) {
      var bi = -1, bs = -1;
      for (i = 0; i < nCand; i++) {
        if (cScore[i] > bs) { bs = cScore[i]; bi = i; }
      }
      if (bi < 0) break;

      var cfi = cFi[bi], cti = cTi[bi], ckind = cKind[bi];
      var mv = {
        from: { x: cfi % W, y: (cfi / W) | 0 },
        dir: DIRN[cD[bi]],
        half: pickHalf(ctx, cfi, cti, ckind),
        fi: cfi,
        ti: cti
      };
      moves.push(mv);
      applyMove(ctx, mv);

      /* 局部刷新：受影响格子及其邻域的派生信息与候选分数 */
      var touched = W2.touched;
      var nT = 0;
      nT = collectAround(ctx, cfi, touched, nT);
      nT = collectAround(ctx, cti, touched, nT);
      for (i = 0; i < nT; i++) {
        dirty[touched[i]] = 1;
        refreshCell(ctx, touched[i]);
      }
      for (i = 0; i < nCand; i++) {
        var fi2 = cFi[i], ti2 = cTi[i];
        if (!dirty[fi2] && !dirty[ti2]) continue;
        var kind2 = classify(ctx, fi2, ti2);
        var sc2 = scoreMove(ctx, fi2, ti2);
        if (sc2 < 0 || !guard(ctx, fi2, ti2, kind2)) { cScore[i] = -1; cKind[i] = kind2; continue; }
        cKind[i] = kind2; cScore[i] = sc2;
      }
      for (i = 0; i < nT; i++) dirty[touched[i]] = 0;
    }

    return { moves: moves, memory: packMem(ctx) };
  }

  /* 城市折算：敌将约等于 2.5 座城 */
  function dCity2(d) { return d * 2.5; }

  /* =================================================================
   * 记忆打包 / 裁剪
   * =============================================================== */
  function packMem(ctx) {
    return {
      genInfo: ctx.genInfo,
      cityInfo: ctx.cityInfo,
      enemySeen: ctx.enemySeen, enemyList: ctx.enemyList,
      assault: ctx.assault || null
    };
  }

  function pruneMem(obj, limit) {
    var cap = limit || 400;
    var keys = Object.keys(obj);
    if (keys.length <= cap) return;
    keys.sort(function (p, q) {
      var a = obj[p] && typeof obj[p].t === 'number' ? obj[p].t : 0;
      var b = obj[q] && typeof obj[q].t === 'number' ? obj[q].t : 0;
      return a - b;
    });
    for (var i = 0; i < keys.length - cap; i++) delete obj[keys[i]];
  }

  /* =================================================================
   * 守军估计：可见则精确；不可见则用上次观测 + 产出推算
   * =============================================================== */
  function estimateDef(ctx, idx) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var tt = ctx.terrain[idx];
    if (ctx.own[idx] !== OWN_UNK) {
      var a = ctx.arm[idx];
      return a >= 0 ? a : (tt === GEN_T ? 1 : 0);
    }
    var rec = (tt === GEN_T) ? ctx.genInfo['' + idx] : ctx.cityInfo['' + idx];
    if (rec && typeof rec.a === 'number' && rec.a >= 0) {
      var g = 1 + Math.floor(ctx.tick / 200);
      var d = ctx.tick - (typeof rec.t === 'number' ? rec.t : 0);
      if (d < 0) d = 0;
      return rec.a + g * d;
    }
    return (tt === GEN_T) ? 25 : 40;
  }

  /* =================================================================
   * BFS：只有山地不可通行；未知地形按乐观可通行处理
   * 方向展开写死，队列只存线性下标
   * =============================================================== */
  function bfsFrom(terrain, W, H, sources, srcCount, useAlt) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var N = W * H;
    var buf = getWorkspace(N);
    var dist = useAlt ? buf.bfsDist2 : buf.bfsDist;
    dist.fill(-1);
    var q = buf.bfsQueue;
    var head = 0, tail = 0;
    var i, s;
    var nSrc = (srcCount === undefined) ? sources.length : srcCount;
    for (i = 0; i < nSrc; i++) {
      s = sources[i];
      if (s >= 0 && s < N && dist[s] === -1) { dist[s] = 0; q[tail++] = s; }
    }
    while (head < tail) {
      var cur = q[head++];
      var cy = (cur / W) | 0;
      var cx = cur - cy * W;
      var nd = dist[cur] + 1;
      var ni;
      if (cy > 0) {
        ni = cur - W;
        if (dist[ni] === -1 && terrain[ni] !== MTN) { dist[ni] = nd; q[tail++] = ni; }
      }
      if (cy < H - 1) {
        ni = cur + W;
        if (dist[ni] === -1 && terrain[ni] !== MTN) { dist[ni] = nd; q[tail++] = ni; }
      }
      if (cx > 0) {
        ni = cur - 1;
        if (dist[ni] === -1 && terrain[ni] !== MTN) { dist[ni] = nd; q[tail++] = ni; }
      }
      if (cx < W - 1) {
        ni = cur + 1;
        if (dist[ni] === -1 && terrain[ni] !== MTN) { dist[ni] = nd; q[tail++] = ni; }
      }
    }
    return dist;
  }

  /* =================================================================
   * 派生量刷新（单个格子 / 邻域）
   * =============================================================== */
  function refreshCell(ctx, idx) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var W = ctx.W, H = ctx.H;
    var x = idx % W, y = (idx / W) | 0;
    var terrain = ctx.terrain, arm = ctx.arm, enemyOf = ctx.enemyOf;
    var adjEnemy = ctx.adjEnemy, adjUnk = ctx.adjUnk;
    var adjGen = ctx.adjGen, frontier = ctx.frontier;
    var mx = 0, unk = 0, fg = 0, fr = 0;
    for (var dy = -1; dy <= 1; dy++) {
      var ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      var rowBase = ny * W;
      for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        var ni = rowBase + nx;
        var nt = terrain[ni];
        if (nt === TUNK) { unk++; fr = 1; continue; }
        if (enemyOf[ni]) {
          fr = 1;
          if (dx === 0 || dy === 0) {
            var ea = arm[ni];
            if (ea > mx) mx = ea;
          }
          if (nt === GEN_T) fg = 1;
        }
      }
    }
    adjEnemy[idx] = mx;
    adjUnk[idx] = unk;
    adjGen[idx] = fg;
    frontier[idx] = fr;
  }

  function collectAround(ctx, idx, out, n) {
    var W = ctx.W, H = ctx.H;
    var x = idx % W, y = (idx / W) | 0;
    for (var dy = -1; dy <= 1; dy++) {
      var ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (var dx = -1; dx <= 1; dx++) {
        var nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        out[n++] = ny * W + nx;
      }
    }
    return n;
  }

  /* =================================================================
   * 候选生成 / 分类 / 合法性护栏
   * =============================================================== */
  function classify(ctx, fi, ti) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var to = ctx.own[ti];
    if (to >= 0) {
      if (ctx.friendOf[ti]) return KIND_REINF;
      return KIND_ATTACK;
    }
    return KIND_EXPAND;
  }

  /* 不从被威胁的格子里抽干兵力（除非目标更危险） */
  function guard(ctx, fi, ti, kind) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    if (kind === KIND_ATTACK) return true;
    var srcT = ctx.adjEnemy[fi];
    if (srcT >= 6) {
      var a = ctx.arm[fi];
      if (a < 8 && ctx.adjEnemy[ti] < srcT) return false;
    }
    return true;
  }

  /* "增援"类候选绝大多数是内部倒腾（得分接近 0），先用便宜的判断筛掉，
     只有这几种情况才真正值得调兵：目标被威胁 / 目标是需要支援的边缘格 /
     这次调兵能往焦点靠拢。 */
  function reinfUseful(ctx, fi, ti) {
    if (ctx.adjEnemy[ti] >= 4) return true;
    if (ctx.frontier[ti] && ctx.arm[ti] < 3) return true;
    var dt = ctx.distTarget;
    if (dt) {
      var dF = dt[fi], dT = dt[ti];
      if (dF >= 0 && dT >= 0 && dT < dF) return true;
    }
    return false;
  }

  /* 非进攻移动必须给出发格留下足够守备，避免满地图都是 1 兵小碎块；
     开新格子时新格也至少要有 2 兵（否则一碰就碎，全场打不出拳）。 */
  function keepFloor(ctx, fi, ti, kind) {
    var a = ctx.arm[fi];
    var k = sendAmount(ctx, fi, ti, kind);
    if (k < 1) return false;
    var fl = ctx.floor[fi];
    /* 普通格不设限（薄铺快扩是这个规则下的最优解），
       只有将军/城市需要留底，免得被 2 兵顺手端掉。 */
    if (ctx.defending && fl >= 3 && (a - k) < 2) return false;
    return true;
  }

  function buildCandidates(ctx) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var W = ctx.W, H = ctx.H;
    var own = ctx.own, arm = ctx.arm, terrain = ctx.terrain;
    var myId = ctx.myId;
    var adjEnemy = ctx.adjEnemy, friendOf = ctx.friendOf;
    var cFi = ctx.cFi, cTi = ctx.cTi, cD = ctx.cD, cKind = ctx.cKind, cScore = ctx.cScore;
    var n = 0;
    for (var y = 0; y < H; y++) {
      var rowBase = y * W;
      for (var x = 0; x < W; x++) {
        var fi = rowBase + x;
        if (own[fi] !== myId) continue;
        var af = arm[fi];
        if (af < 2) continue;

        /* 内部格（四邻都是自己人）且兵力不大时无事可做，直接跳过：
           在"大片己方领土"的局面里，这类格子占绝大多数，
           逐个枚举纯属浪费（每 tick 最多 4 条指令，用不上这么多候选）。 */
        if (af < 12) {
          var outNb = false;
          if (y > 0 && !friendOf[fi - W]) outNb = true;
          else if (y < H - 1 && !friendOf[fi + W]) outNb = true;
          else if (x > 0 && !friendOf[fi - 1]) outNb = true;
          else if (x < W - 1 && !friendOf[fi + 1]) outNb = true;
          if (!outNb) {
            var nearThreat = false;
            if (y > 0 && adjEnemy[fi - W] >= 4) nearThreat = true;
            else if (y < H - 1 && adjEnemy[fi + W] >= 4) nearThreat = true;
            else if (x > 0 && adjEnemy[fi - 1] >= 4) nearThreat = true;
            else if (x < W - 1 && adjEnemy[fi + 1] >= 4) nearThreat = true;
            if (!nearThreat) continue;
          }
        }

        /* up */
        if (y > 0) {
          var ti = fi - W;
          if (terrain[ti] !== MTN) {
            var kind = classify(ctx, fi, ti);
            if (kind !== KIND_REINF || reinfUseful(ctx, fi, ti)) {
              var sc = scoreMove(ctx, fi, ti);
              if (sc >= 0 && guard(ctx, fi, ti, kind) && keepFloor(ctx, fi, ti, kind)) {
                cFi[n] = fi; cTi[n] = ti; cD[n] = 0; cKind[n] = kind; cScore[n] = sc; n++;
              }
            }
          }
        }
        /* right */
        if (x < W - 1) {
          var ti2 = fi + 1;
          if (terrain[ti2] !== MTN) {
            var k2 = classify(ctx, fi, ti2);
            if (k2 !== KIND_REINF || reinfUseful(ctx, fi, ti2)) {
              var s2 = scoreMove(ctx, fi, ti2);
              if (s2 >= 0 && guard(ctx, fi, ti2, k2) && keepFloor(ctx, fi, ti2, k2)) {
                cFi[n] = fi; cTi[n] = ti2; cD[n] = 1; cKind[n] = k2; cScore[n] = s2; n++;
              }
            }
          }
        }
        /* down */
        if (y < H - 1) {
          var ti3 = fi + W;
          if (terrain[ti3] !== MTN) {
            var k3 = classify(ctx, fi, ti3);
            if (k3 !== KIND_REINF || reinfUseful(ctx, fi, ti3)) {
              var s3 = scoreMove(ctx, fi, ti3);
              if (s3 >= 0 && guard(ctx, fi, ti3, k3) && keepFloor(ctx, fi, ti3, k3)) {
                cFi[n] = fi; cTi[n] = ti3; cD[n] = 2; cKind[n] = k3; cScore[n] = s3; n++;
              }
            }
          }
        }
        /* left */
        if (x > 0) {
          var ti4 = fi - 1;
          if (terrain[ti4] !== MTN) {
            var k4 = classify(ctx, fi, ti4);
            if (k4 !== KIND_REINF || reinfUseful(ctx, fi, ti4)) {
              var s4 = scoreMove(ctx, fi, ti4);
              if (s4 >= 0 && guard(ctx, fi, ti4, k4) && keepFloor(ctx, fi, ti4, k4)) {
                cFi[n] = fi; cTi[n] = ti4; cD[n] = 3; cKind[n] = k4; cScore[n] = s4; n++;
              }
            }
          }
        }
      }
    }
    return n;
  }

  /* =================================================================
   * 评分
   * =============================================================== */
  function scoreMove(ctx, fi, ti) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var arm = ctx.arm, terrain = ctx.terrain, own = ctx.own;
    var a = arm[fi];
    var to = own[ti];
    var toward = 0;

    var dt = ctx.distTarget;
    if (dt !== null) {
      var dF = dt[fi], dT = dt[ti];
      if (dF >= 0 && dT >= 0) {
        if (dT === dF - 1) toward = ctx.towardW;
        else if (dT < dF) toward = ctx.towardW * 0.45;
      }
    }

    if (to >= 0 && ctx.friendOf[ti] === 1) return scoreReinforce(ctx, fi, ti, toward);

    /* 回防：家门有威胁时，往将军方向靠拢的移动优先 */
    var defendPull = 0;
    if (ctx.defending && ctx.distDef) {
      var ddf = ctx.distDef[fi], ddt = ctx.distDef[ti];
      if (ddf >= 0 && ddt >= 0 && ddt < ddf) defendPull = ctx.defendBonus;
    }

    var k = a - 1;                     // half:false 的发送量（最大火力）
    if (k < 1) return -1;

    if (to === OWN_NEU) {
      /* 中立格 */
      if (terrain[ti] === CITY_T) {
        var g = arm[ti]; if (g < 0) g = 45;
        if (k <= g) return -1;
        /* 城池产能极高，值得尽早拿下；但不能把家底打光 */
        if (ctx.myArmyTotal - k < 10) return -1;
        return 1300 + toward * 0.4 + (ctx.phase === 2 ? 150 : 0);
      }
      var sc = 250 + defendPull;
      if (ctx.adjUnk[ti] > 0) sc += 60;
      if (ctx.adjEnemy[ti] > 0) sc += 70;
      return sc + toward;
    }

    if (to === OWN_UNK) {
      /* 视野外：地形已知但归属未知 */
      var tt = terrain[ti];
      if (tt === TUNK) {
        return 250 + 45 * ctx.adjUnk[ti] + toward * 0.7 + defendPull;
      }
      if (tt === GEN_T) {
        var dg = ctx.specialDef[ti];
        if (k <= dg) return -1;
        return 6000 - dg + toward;
      }
      if (tt === CITY_T) {
        var dc = ctx.specialDef[ti];
        if (k <= dc) return -1;
        return 500 - dc * 0.4 + toward * 0.6;
      }
      return 130 + toward * 0.6;
    }

    /* 敌方格（与己方格相邻 ⇒ 必然可见，守军精确） */
    var def = arm[ti];
    if (def < 0) def = ctx.specialDef[ti] > 0 ? ctx.specialDef[ti] : 0;
    if (k <= def) return -1;
    if (terrain[ti] === GEN_T) return 6000 - def + toward;

    var base = 500 - def * 0.9 + defendPull;
    if (def <= 2) base += 110;
    if (ti === ctx.focusIdx) base += 700;             // 直捣敌方首都
    if (ctx.adjGen[ti]) base = 900 - def;
    if (ctx.prio[ti] && base < 2000 - def) base = 2000 - def;
    if (ctx.adjEnemy[ti] >= 6) base += 250 + def * 2;
    if (terrain[ti] === CITY_T) base += 420;       // 敌方城市 = 额外生产力
    base += toward * 0.6;
    return base * ctx.attackFactor;
  }

  function scoreReinforce(ctx, fi, ti, toward) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var arm = ctx.arm;
    var a = arm[fi], tA = arm[ti];
    var s = 0;
    var threat = ctx.adjEnemy[ti];
    if (threat >= 4) s += 250 + threat * 9;          // 救火
    if (ctx.frontier[ti]) {
      s += 45;
      if (tA < 3) s += 130;                         // 别让边缘格只有 1~2 人被秒
    }
    s += toward;                                    // 向目标集结
    if (ctx.defending && ctx.distDef) {
      var ddf2 = ctx.distDef[fi], ddt2 = ctx.distDef[ti];
      if (ddf2 >= 0 && ddt2 >= 0 && ddt2 < ddf2) s += ctx.defendBonus;
    }
    if (a < 3) s -= 250;                            // 别把小队抽干
    else if (a > 18) s += 60;                       // 大队可以流动
    if (s < 1) s = 1;                               // 保证总有一个可执行动作
    return s;
  }

  /* =================================================================
   * 半 / 全量出击的选择
   * 进攻永远全力（half:false）；向目标集结且兵力充足时也倾巢而出。
   * =============================================================== */
  function pickHalf(ctx, fi, ti, kind) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    if (kind === KIND_ATTACK) return false;          // 进攻永远全力
    var a = ctx.arm[fi];
    var dt = ctx.distTarget;
    if (dt !== null) {
      var dF = dt[fi], dT = dt[ti];
      if (dF >= 0 && dT >= 0 && dT < dF && a >= 14) return false;  // 集结时倾巢而出
    }
    return true;
  }

  /* 这次移动实际会送出多少兵 */
  function sendAmount(ctx, fi, ti, kind) {
    var a = ctx.arm[fi];
    if (kind === KIND_ATTACK) return a - 1;
    if (kind === KIND_EXPAND) {
      var k = a >> 1;
      if (k > ctx.expCap) k = ctx.expCap;          // 扩张只派小队，别把家底散光
      return k;
    }
    if (pickHalf(ctx, fi, ti, kind)) return a >> 1;
    return a - 1;
  }

  /* =================================================================
   * 本地模拟结算（与协议结算顺序一致）
   * =============================================================== */
  function applyMove(ctx, mv) {
    var MTN = 1, CITY_T = 2, GEN_T = 3, TUNK = -1, OWN_UNK = -2, OWN_NEU = -1;
    var fi = mv.fi, ti = mv.ti;
    var a = ctx.arm[fi];
    var k = mv.half ? Math.floor(a / 2) : a - 1;
    if (k < 1) k = 1;
    if (k > a) k = a;
    ctx.arm[fi] = a - k;

    var to = ctx.own[ti];
    var terrain = ctx.terrain;

    if (to >= 0 && ctx.friendOf[ti] === 1) {        // 增援
      ctx.arm[ti] += k;
      return;
    }

    var def;
    if (to === OWN_UNK) {
      var tt = terrain[ti];
      if (tt === TUNK) {                            // 未知地形：乐观当作空地
        ctx.own[ti] = ctx.myId;
        ctx.arm[ti] = k;
        ctx.friendOf[ti] = 1;
        return;
      }
      def = ctx.specialDef[ti] > 0 ? ctx.specialDef[ti] : 0;
    } else {
      def = ctx.arm[ti] > 0 ? ctx.arm[ti] : 0;
    }

    if (k > def) {
      if (to >= 0 && terrain[ti] === GEN_T) {
        /* 攻陷敌方将军：其全部领土归我，兵力减半，将军格变为城市 */
        for (var q = 0; q < ctx.N; q++) {
          if (ctx.own[q] === to) {
            ctx.own[q] = ctx.myId;
            ctx.arm[q] = Math.max(1, Math.floor(ctx.arm[q] / 2));
          }
        }
        ctx.terrain[ti] = CITY_T;
        ctx.own[ti] = ctx.myId;
        ctx.arm[ti] = k - def;
        ctx.friendOf[ti] = 1;
        ctx.specialDef[ti] = 0;
        return;
      }
      ctx.own[ti] = ctx.myId;
      ctx.arm[ti] = k - def;
      ctx.friendOf[ti] = 1;
    } else {
      ctx.arm[ti] = def - k;
    }
  }

  return runStrategy;
})();
