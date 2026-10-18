'use strict';

/* =====================================================================
 * strategy.js — 迷宫竞速 · 走迷宫策略 (runner)
 * ---------------------------------------------------------------------
 * 核心思路:每 tick 滚动重规划(receding horizon),对追逐者、闸门、
 * 机关的动态变化保持鲁棒。
 *
 *   1. 追逐者威胁场:多源 BFS 得到每个格子到最近追逐者的步数。
 *   2. 时间展开 BFS:状态 = (格子, tick)。严格按结算时序建模:
 *      - 在 tick τ 移动进入格子 n,要求 n 在 τ 时刻闸门开放;
 *      - 在 tick τ 结束后位于格子 n(无论移动还是等待),若 n 的
 *        机关在 τ 激活则受伤,因此把"τ 时刻激活机关的格子"视为禁区;
 *      - 原地等待(wait)同样按 τ 结算检查机关。
 *   3. 追逐者规避三级松弛:slack=2 → 0 → 完全关闭(仅在锚点不可达
 *      且血量允许/时间将尽时),保证必经点(钥匙/出口)总能规划出来。
 *   4. 目标选择:锚点 = 无钥→钥匙 / 有钥→出口;在绕行预算内
 *      序贯贪心收集晶片,并用迟滞(hysteresis)防抖。
 *   5. 危险时进入逃避模式:最大化与追逐者的距离,用"树深"惩罚
 *      死胡同,朝目标方向给少量加分以边逃边跑。
 *
 * 约定:完全确定性(无 Date/Math.random 等非确定输入);
 *      状态存 Worker 顶层变量(协议允许跨决策保留),不返回 memory;
 *      任何异常兜底返回 'wait',保证永不 status=error。
 * =================================================================== */

var DIRS = [
  { a: 'up',    dx: 0, dy: -1 },
  { a: 'right', dx: 1, dy: 0 },
  { a: 'down',  dx: 0, dy: 1 },
  { a: 'left',  dx: -1, dy: 0 }
];

var HORIZON      = 220;   /* 时间展开 BFS 最大前瞻层数(tick) */
var HUNTER_CAP   = 6;     /* 猎手威胁前瞻封顶(tick):远期位置不可信,靠重规划适应 */
var UNREACH     = 30000;  /* 不可达哨兵(Int16 安全) */
var END_MARGIN  = 12;     /* 终局时间余量(tick) */
var COIN_FACTOR = 0.65;   /* 晶片绕行预算系数 */
var EARLY_WINDOW = 26;    /* 锚点到达后再多搜的层数窗口(≥晶片预算上限24) */

/* ---- 跨决策状态(同一局内有效;seed 不符自动重建) ---- */
var MAP         = null;
var COMMIT      = null;   /* {cell} 晶片目标迟滞 */
var LAST        = -1;     /* 上一 tick 所在格(逃避防抖) */
var STUCK       = 0;      /* 锚点不可达的连续 tick 数(受困计数) */
var COINS_SEEN  = 0;
var TOTAL_COINS = 0;

var _hDist   = null;  /* Int16Array: 各格到最近追逐者的 BFS 步数 */
var _sd      = null;  /* Int16Array: 静态 BFS 距离(共享缓冲) */
var _sq      = null;  /* Int32Array: BFS 队列(共享) */
var _tvis    = null;  /* Uint8Array: 时间 BFS 状态标记 */
var _tpar    = null;  /* Int32Array: 时间 BFS 父状态索引 */
var _front   = null;  /* Int32Array: 当前层边界 */
var _fnext   = null;  /* Int32Array: 下一层边界 */
var _arrival = null;  /* Int32Array: 各格最早到达(相对层数,-1 不可达) */

function decide(o) {
  try {
    return runner(o);
  } catch (e) {
    return { action: 'wait' };
  }
}

/* ============================== 主流程 ============================== */

function runner(o) {
  const W = o.width, H = o.height;
  const N = W * H;
  if (!MAP || MAP.seed !== o.seed || MAP.W !== W || MAP.H !== H) ensureMap(o);
  if (o.coins.length > COINS_SEEN) COINS_SEEN = o.coins.length;

  const t = o.tick;
  const hE = o.hunterEvery;
  const me = o.player.y * W + o.player.x;
  const remaining = o.maxTicks - t;
  const hasKey = o.player.hasKey === true;
  const keyCell = o.key ? (o.key.y * W + o.key.x) : -1;
  const exitCell = o.exit.y * W + o.exit.x;
  const anchor = hasKey ? exitCell : (keyCell >= 0 ? keyCell : exitCell);

  /* 追逐者威胁场 */
  hunterField(o);

  const myHD = _hDist[me];
  const baseDanger = (hE === 2 ? 5 : 6);   /* 常规危险半径(tick) */

  /* --- 规划:三级松弛的时间展开 BFS --- */
  let offRun = false;
  timeBFS(o, t, me, 2, anchor);
  if (_arrival[anchor] < 0) timeBFS(o, t, me, 0, anchor);
  if (_arrival[anchor] < 0 && (o.player.hp >= 2 || remaining < 30)) {
    timeBFS(o, t, me, -10000, anchor);
    offRun = true;
  }

  /* 受困计数:安全规划(带猎手规避)无法抵达锚点时累加 */
  const safeBlocked = offRun || _arrival[anchor] < 0;
  if (safeBlocked) STUCK++; else STUCK = 0;

  /* 危险判定(分层):
   * - 1 血:保守半径,早点逃;
   * - 血量 ≥2 且安全规划存在:只在贴脸(≤1 步)才打断计划
   *   (规划器自身已避免碰撞,频繁打断反而造成"永远在路上");
   * - 血量 ≥2 且被围/被蹲(无安全规划):常规半径逃避。 */
  let dangerNow;
  if (o.player.hp === 1) {
    dangerNow = myHD < 9000 && myHD * hE <= baseDanger + 3;
  } else {
    dangerNow = myHD <= 1 || (safeBlocked && myHD < 9000 && myHD * hE <= baseDanger);
  }

  /* --- 危险:逃避优先(迟滞目标一并清除)。
   * 例外(硬闯):突围模式 offRun 且血量 ≥2,且满足其一:
   *   a) 追逐者就蹲在锚点附近(≈4 步内,蹲守型封锁);
   *   b) 连续 24 tick 被围困(口袋型封锁,逃避只会越缩越深)。
   * 挨一次打换无敌帧穿过封锁;对普通追击者仍靠周旋等其让路。 --- */
  const campy = _hDist[anchor] <= 4;
  if (dangerNow && !(offRun && o.player.hp >= 2 && (campy || STUCK >= 24))) {
    COMMIT = null;
    LAST = me;
    return { action: evade(o, t, me, anchor, exitCell, hasKey) };
  }
  LAST = me;

  let goal = anchor;

  /* --- 晶片目标(仅在安全规划下考虑;绝望路径直奔锚点) --- */
  /* 抢先夺钥:血量 ≥2 且某个追逐者能先于我们到钥匙(可能蹲守)时,
   * 先拿钥匙再顺路捡币,避免"币捡完钥匙被蹲死"的时序错误。 --- */
  let rushKey = false;
  if (!hasKey && keyCell >= 0 && o.player.hp >= 2) {
    const hdk = _hDist[keyCell];
    if (hdk < 9000 && hdk * hE - 1 < _arrival[keyCell]) rushKey = true;
  }
  if (_arrival[anchor] >= 0 && remaining > END_MARGIN && !offRun && !rushKey) {
    const dA = _arrival[anchor];
    const anchorD = staticBFS(anchor);
    const totalCoins = Math.max(TOTAL_COINS, COINS_SEEN, o.coins.length);
    const coinVal = totalCoins > 0 ? 1000 / totalCoins : 0;
    const tickVal = o.maxTicks > 0 ? 2000 / o.maxTicks : 1;
    let budget = tickVal > 0 ? Math.floor((coinVal / tickVal) * COIN_FACTOR) : 12;
    if (budget < 6) budget = 6;
    if (budget > 24) budget = 24;

    let bestCell = -1, bestTotal = 0;
    for (let i = 0; i < o.coins.length; i++) {
      const cell = o.coins[i].y * W + o.coins[i].x;
      if (cell === anchor) continue;
      const total = coinLeg(cell, anchorD);
      if (total < 0) continue;
      if (total + END_MARGIN > remaining) continue;
      if (total - dA > budget) continue;
      if (bestCell < 0 || total < bestTotal || (total === bestTotal && cell < bestCell)) {
        bestCell = cell;
        bestTotal = total;
      }
    }

    /* 迟滞:维持上轮目标,除非新目标明显更优(≥4 tick) */
    if (COMMIT) {
      let stillThere = false;
      for (let i = 0; i < o.coins.length; i++) {
        if (o.coins[i].y * W + o.coins[i].x === COMMIT.cell) { stillThere = true; break; }
      }
      const ct = stillThere ? coinLeg(COMMIT.cell, anchorD) : -1;
      if (ct >= 0 && ct + END_MARGIN <= remaining && ct - dA <= budget &&
          (bestCell < 0 || ct <= bestTotal + 4)) {
        goal = COMMIT.cell;
      } else {
        COMMIT = null;
      }
    }
    if (goal === anchor && bestCell >= 0) {
      goal = bestCell;
      COMMIT = { cell: bestCell };
    }
  } else {
    COMMIT = null;
  }

  /* --- 锚点被封死(例如被蹲守)→ 就近取可达晶片 --- */
  if (_arrival[goal] < 0) {
    let bc = -1, bd = -1;
    for (let i = 0; i < o.coins.length; i++) {
      const cell = o.coins[i].y * W + o.coins[i].x;
      const d = _arrival[cell];
      if (d >= 0 && (bc < 0 || d < bd)) { bc = cell; bd = d; }
    }
    if (bc >= 0) goal = bc;
  }

  const c1 = firstStepCell(me, goal);
  let act = null;
  if (c1 >= 0) act = stepAction(me, c1, W);
  if (act === null) {
    act = staticFallback(me, goal, t);
    if (act === null) act = staticFallback(me, anchor, t);
    /* 1 血时不要沿静态路走进追逐者怀抱(蹲守僵局 → 保持安全距离等待时机) */
    if (act !== null && act !== 'wait' && o.player.hp === 1) {
      const dxs = act === 'right' ? 1 : act === 'left' ? -1 : 0;
      const dys = act === 'down' ? 1 : act === 'up' ? -1 : 0;
      const nCell = me + dys * W + dxs;
      const hdn = _hDist[nCell];
      if (hdn < 9000 && hdn * hE <= 6) act = evade(o, t, me, anchor, exitCell, hasKey);
    }
    if (act === null) act = 'wait';
  }
  return { action: act };
}

/* 晶片 total = (我→晶片的时间到达层数) + (晶片→锚点的静态步数) */
function coinLeg(cell, anchorD) {
  const dC = _arrival[cell];
  if (dC < 0) return -1;
  const dCG = anchorD[cell];
  if (dCG < 0) return -1;
  return dC + dCG;
}

/* ============================== 逃避模式 ============================== */

function evade(o, t, me, anchor, exitCell, hasKey) {
  const W = MAP.W, H = MAP.H;
  const x0 = me % W, y0 = (me / W) | 0;

  /* 持钥且出口相邻、闸门开放 → 直接进(成功结算优先于伤害与机关) */
  if (hasKey) {
    for (let k = 0; k < 4; k++) {
      const nx = x0 + DIRS[k].dx, ny = y0 + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (n !== exitCell || MAP.open[n] !== 1) continue;
      const gi = MAP.gateIdx[n];
      if (gi >= 0 && MAP.gates[gi].lut[t % MAP.gates[gi].period] === 1) continue;
      return DIRS[k].a;
    }
  }

  /* 朝锚点方向的第一步(用于逃跑时仍尽量推进;
   * 1 血且锚点被蹲时朝锚点偏置反而送死,关掉) */
  let bias = -1;
  if (_arrival[anchor] > 0 && o.player.hp >= 2) bias = firstStepCell(me, anchor);

  let bestAct = 'wait', bestScore = -1e9;
  for (let k = 0; k < 5; k++) {
    let act = 'wait', nx = x0, ny = y0;
    if (k < 4) {
      act = DIRS[k].a;
      nx = x0 + DIRS[k].dx;
      ny = y0 + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    }
    const n = ny * W + nx;
    if (k < 4) {
      if (MAP.open[n] !== 1) continue;
      const gi = MAP.gateIdx[n];
      if (gi >= 0 && MAP.gates[gi].lut[t % MAP.gates[gi].period] === 1) continue;
    }
    const ti = MAP.trapIdx[n];
    if (ti >= 0 && MAP.traps[ti].lut[t % MAP.traps[ti].period] === 1) continue;

    let hd = _hDist[n];
    if (hd >= 9000) hd = 30;
    let sc = hd * 10;                       /* 主项:远离追逐者 */
    const td = MAP.treeDepth[n];
    if (td > 0) sc -= td * 12;              /* 死胡同惩罚(略强于距离收益) */
    if (MAP.safe[n] === 1) sc += 2;         /* 环路/岔口加分 */
    if (n === bias) sc += 4;                /* 顺路加分 */
    if (n === LAST) sc -= 2;                /* 轻微避免回跳上一格 */
    if (k === 4) sc -= 3;                  /* 轻微偏好移动 */
    if (sc > bestScore) { bestScore = sc; bestAct = act; }
  }
  return bestAct;
}

/* ============================== 路径提取 ============================== */

/* 返回从 startCell 出发、通往 goalCell 最早到达路径的第一步所在格;
 * 不可达返回 -1;goal==start 返回 start。 */
function firstStepCell(startCell, goalCell) {
  const N = MAP.N;
  const L = _arrival[goalCell];
  if (L < 0) return -1;
  if (L === 0) return startCell;
  let idx = L * N + goalCell;
  let par = _tpar[idx];
  while (par >= N) { idx = par; par = _tpar[idx]; }
  return idx - N;   /* 第一层格子的编号 */
}

function stepAction(from, to, W) {
  if (to === from) return 'wait';
  const dx = (to % W) - (from % W);
  const dy = ((to / W) | 0) - ((from / W) | 0);
  if (dx === 1) return 'right';
  if (dx === -1) return 'left';
  if (dy === 1) return 'down';
  if (dy === -1) return 'up';
  return 'wait';
}

/* ============================== 时间展开 BFS ============================== */

/* 从 (startCell, t0) 出发的时间展开 BFS。
 * slack: 追逐者规避强度;
 *   slack = 2  → 追逐者预计到达时间 ≤ 我到达时间+2 的格子视为禁区
 *   slack = 0  → 仅排除可能与追逐者同时/更晚到达的格子
 *   slack ≤ -10000 → 突围模式:忽略追逐者时序(机关仍严格避开,可能挨打)
 * 锚点到达后再搜 EARLY_WINDOW 层即停(晶片窗口),控制单次开销。 */
function timeBFS(o, t0, startCell, slack, anchorC) {
  const N = MAP.N, W = MAP.W, H = MAP.H, open = MAP.open;
  const gateIdx = MAP.gateIdx, trapIdx = MAP.trapIdx;
  const gates = MAP.gates, traps = MAP.traps;
  const hE = o.hunterEvery;
  const off = slack <= -1000;
  const exitC = o.exit.y * W + o.exit.x;
  const hasKey = o.player.hasKey === true;

  let maxL = Math.min(HORIZON, o.maxTicks - t0);
  if (maxL < 1) maxL = 1;

  const totalStates = N * (maxL + 1);
  _tvis.fill(0, 0, totalStates);
  _arrival.fill(-1);
  _arrival[startCell] = 0;
  _tvis[startCell] = 1;
  _tpar[startCell] = -1;
  let fl = 0;
  _front[fl++] = startCell;
  let stallN = 0;

  for (let L = 0; L < maxL && fl > 0; L++) {
    const aA = _arrival[anchorC];
    if (aA >= 0 && L > aA + EARLY_WINDOW) break;   /* 提前收敛 */

    const tau = t0 + L;         /* 本层转移在结算 tick tau 生效 */
    const baseIn = L * N;
    const baseOut = baseIn + N;
    let nl = 0;
    let newCells = 0;

    for (let i = 0; i < fl; i++) {
      const c = _front[i];
      const x = c % W, y = (c / W) | 0;
      /* 等待剪枝:只有当至少一个移动方向被"时序"(闸门关闭/机关激活)挡住时,
       * 在本格等待才有意义(等待是为了解锁时序;最早到达路径不含无用等待,
       * 猎手在本轮 BFS 里视为静止,等它也没有意义)。 */
      let timingBlocked = false;

      for (let k = 0; k < 5; k++) {
        let n;
        if (k < 4) {
          const nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          n = ny * W + nx;
          if (open[n] !== 1) continue;
        } else {
          if (!timingBlocked) continue;   /* 无时序解锁前景:不生成等待状态 */
          n = c;                /* 原地等待 */
        }
        const idx = baseOut + n;
        if (_tvis[idx] === 1) continue;

        const isExit = (n === exitC && hasKey);   /* 持钥踩出口=成功,优先于伤害 */

        if (k < 4) {
          const gi = gateIdx[n];
          if (gi >= 0 && gates[gi].lut[tau % gates[gi].period] === 1) { timingBlocked = true; continue; } /* 闸门关闭:不可进入,可等 */
        }
        if (!isExit) {
          const ti = trapIdx[n];
          if (ti >= 0 && traps[ti].lut[tau % traps[ti].period] === 1) { timingBlocked = true; continue; } /* 机关激活:可等其关闭 */
        }
        if (!isExit && !off && slack >= 0) {
          const hd = _hDist[n];
          /* 追逐者预计占据 n 的相对时刻 = hd*hE-1,但前瞻封顶 HUNTER_CAP:
           * 远期位置是 speculation,留给每 tick 重规划去适应 */
          if (hd < 9000 && hd * hE - 1 <= (L > HUNTER_CAP ? HUNTER_CAP : L) + slack) continue;
        }

        _tvis[idx] = 1;
        _tpar[idx] = baseIn + c;
        if (_arrival[n] < 0) { _arrival[n] = L + 1; newCells++; }
        _fnext[nl++] = n;
      }
    }
    const tmp = _front;
    _front = _fnext;
    _fnext = tmp;
    fl = nl;
    /* 停滞提前终止:追猎封锁集在 L≈HUNTER_CAP+slack 后不再变化,
     * 闸门/机关时序在格子入前沿后 ≤8 层内必然解锁;连续 12 层无
     * 新格子被发现 → 之后也不会再有,提前结束。锚点不可达时的
     * 饱和搜索(220 层全满)由此截断,是性能的关键保险。 */
    if (newCells === 0 && L >= 12) { if (++stallN >= 12) break; }
    else stallN = 0;
  }
}

/* ============================== 威胁场与静态距离 ============================== */

/* 多源 BFS:所有追逐者出发(忽略闸门,偏保守),得各格距最近追逐者步数 */
function hunterField(o) {
  const N = MAP.N, W = MAP.W, H = MAP.H, open = MAP.open;
  _hDist.fill(UNREACH);
  let qt = 0;
  for (let i = 0; i < o.hunters.length; i++) {
    const c = o.hunters[i].y * W + o.hunters[i].x;
    if (_hDist[c] === UNREACH) { _hDist[c] = 0; _sq[qt++] = c; }
  }
  let qh = 0;
  while (qh < qt) {
    const u = _sq[qh++];
    const d = _hDist[u] + 1;
    const x = u % W, y = (u / W) | 0;
    if (y > 0 && open[u - W] === 1 && _hDist[u - W] === UNREACH) { _hDist[u - W] = d; _sq[qt++] = u - W; }
    if (y < H - 1 && open[u + W] === 1 && _hDist[u + W] === UNREACH) { _hDist[u + W] = d; _sq[qt++] = u + W; }
    if (x > 0 && open[u - 1] === 1 && _hDist[u - 1] === UNREACH) { _hDist[u - 1] = d; _sq[qt++] = u - 1; }
    if (x < W - 1 && open[u + 1] === 1 && _hDist[u + 1] === UNREACH) { _hDist[u + 1] = d; _sq[qt++] = u + 1; }
  }
}

/* 仅看墙的静态 BFS(共享缓冲,调用后立即消费) */
function staticBFS(src) {
  const W = MAP.W, H = MAP.H, open = MAP.open;
  _sd.fill(-1);
  _sd[src] = 0;
  let qh = 0, qt = 0;
  _sq[qt++] = src;
  while (qh < qt) {
    const u = _sq[qh++];
    const d = _sd[u] + 1;
    const x = u % W, y = (u / W) | 0;
    if (y > 0 && open[u - W] === 1 && _sd[u - W] < 0) { _sd[u - W] = d; _sq[qt++] = u - W; }
    if (y < H - 1 && open[u + W] === 1 && _sd[u + W] < 0) { _sd[u + W] = d; _sq[qt++] = u + W; }
    if (x > 0 && open[u - 1] === 1 && _sd[u - 1] < 0) { _sd[u - 1] = d; _sq[qt++] = u - 1; }
    if (x < W - 1 && open[u + 1] === 1 && _sd[u + 1] < 0) { _sd[u + 1] = d; _sq[qt++] = u + 1; }
  }
  return _sd;
}

/* 兜底:时间 BFS 失败时,沿静态最短路走一步(避开当前关闭闸门与激活机关,
 * 在同层候选里偏好远离追逐者的方向) */
function staticFallback(me, goal, t) {
  if (goal < 0 || MAP.open[goal] !== 1) return null;
  const W = MAP.W, H = MAP.H;
  const d = staticBFS(goal);
  if (d[me] < 0) return null;
  const x0 = me % W, y0 = (me / W) | 0;
  let bestAct = null, bestScore = -1e9;
  for (let k = 0; k < 4; k++) {
    const nx = x0 + DIRS[k].dx, ny = y0 + DIRS[k].dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const n = ny * W + nx;
    if (MAP.open[n] !== 1) continue;
    if (d[n] !== d[me] - 1) continue;   /* 只沿静态最短路 */
    const gi = MAP.gateIdx[n];
    if (gi >= 0 && MAP.gates[gi].lut[t % MAP.gates[gi].period] === 1) continue;
    const ti = MAP.trapIdx[n];
    if (ti >= 0 && MAP.traps[ti].lut[t % MAP.traps[ti].period] === 1) continue;  /* 激活机关直接排除 */
    let hd = _hDist[n];
    if (hd >= 9000) hd = 30;
    const sc = hd * 2;
    if (sc > bestScore) { bestScore = sc; bestAct = DIRS[k].a; }
  }
  return bestAct;
}

/* ============================== 地图静态分析 ============================== */

function ensureMap(o) {
  const W = o.width, H = o.height, N = W * H;
  const open = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const row = o.grid[y];
    for (let x = 0; x < W; x++) open[y * W + x] = row[x] === 0 ? 1 : 0;
  }

  /* 闸门/机关 → 格子索引 + 周期查找表 */
  const gateIdx = new Int32Array(N).fill(-1);
  const trapIdx = new Int32Array(N).fill(-1);
  const gates = [], traps = [];
  for (let i = 0; i < o.gates.length; i++) {
    const g = o.gates[i];
    const c = g.y * W + g.x;
    if (c < 0 || c >= N) continue;
    gateIdx[c] = gates.length;
    gates.push({ period: g.period, on: g.on, lut: buildLUT(g.period, g.on, g.phase) });
  }
  for (let i = 0; i < o.traps.length; i++) {
    const tr = o.traps[i];
    const c = tr.y * W + tr.x;
    if (c < 0 || c >= N) continue;
    trapIdx[c] = traps.length;
    traps.push({ period: tr.period, on: tr.on, lut: buildLUT(tr.period, tr.on, tr.phase) });
  }

  /* 度数 */
  const deg = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (open[c] !== 1) continue;
    const x = c % W, y = (c / W) | 0;
    let d = 0;
    if (y > 0 && open[c - W] === 1) d++;
    if (y < H - 1 && open[c + W] === 1) d++;
    if (x > 0 && open[c - 1] === 1) d++;
    if (x < W - 1 && open[c + 1] === 1) d++;
    deg[c] = d;
  }

  /* 环格判定:删点连通性(移除该格后其两个邻居仍连通 → 在环上) */
  const ring = computeRing(open, W, H, N);

  const safe = new Uint8Array(N);
  for (let c = 0; c < N; c++) safe[c] = (ring[c] === 1 || deg[c] >= 3) ? 1 : 0;

  /* 树深:到最近"环格或三岔口"的步数(逃避模式用来避开死胡同) */
  const treeDepth = new Int16Array(N).fill(-1);
  {
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let c = 0; c < N; c++) {
      if (safe[c] === 1 && open[c] === 1) { treeDepth[c] = 0; q[qt++] = c; }
    }
    while (qh < qt) {
      const u = q[qh++];
      const nd = treeDepth[u] + 1;
      const x = u % W, y = (u / W) | 0;
      if (y > 0 && open[u - W] === 1 && treeDepth[u - W] < 0) { treeDepth[u - W] = nd; q[qt++] = u - W; }
      if (y < H - 1 && open[u + W] === 1 && treeDepth[u + W] < 0) { treeDepth[u + W] = nd; q[qt++] = u + W; }
      if (x > 0 && open[u - 1] === 1 && treeDepth[u - 1] < 0) { treeDepth[u - 1] = nd; q[qt++] = u - 1; }
      if (x < W - 1 && open[u + 1] === 1 && treeDepth[u + 1] < 0) { treeDepth[u + 1] = nd; q[qt++] = u + 1; }
    }
  }

  MAP = {
    seed: o.seed, W: W, H: H, N: N, open: open,
    gateIdx: gateIdx, trapIdx: trapIdx, gates: gates, traps: traps,
    deg: deg, safe: safe, treeDepth: treeDepth
  };

  /* 关卡晶片总数(按尺寸查表;tick 0 的观测长度兜底) */
  TOTAL_COINS = (W === 21 && H === 15) ? 8
              : (W === 29 && H === 21) ? 12
              : (W === 35 && H === 25) ? 16
              : Math.max(8, Math.round(N / 45));
  COINS_SEEN = 0;
  COMMIT = null;
  STUCK = 0;
  LAST = -1;

  /* 可复用缓冲 */
  _hDist   = new Int16Array(N);
  _sd      = new Int16Array(N);
  _sq      = new Int32Array(N);
  _tvis    = new Uint8Array(N * (HORIZON + 2));
  _tpar    = new Int32Array(N * (HORIZON + 2));
  _front   = new Int32Array(N);
  _fnext   = new Int32Array(N);
  _arrival = new Int32Array(N);
}

/* 周期查找表:lut[k]=1 表示绝对 tick ≡ k (mod period) 时闸门关闭/机关激活 */
function buildLUT(period, on, phase) {
  if (!period || period < 1) period = 1;
  const lut = new Uint8Array(period);
  for (let k = 0; k < period; k++) {
    lut[k] = ((k + phase) % period) < on ? 1 : 0;
  }
  return lut;
}

/* 删点连通性检测环格:
 * 对每个通道格 c,封锁 c 后从其一个邻居 BFS,若能绕到另一个邻居,
 * 说明 c 落在某个环上。O(N·(N+E)),每局只算一次。 */
function computeRing(open, W, H, N) {
  const ring = new Uint8Array(N);
  const vis = new Int32Array(N);
  const q = new Int32Array(N);
  const nb = new Int32Array(4);
  for (let c = 0; c < N; c++) {
    if (open[c] !== 1) continue;
    const x = c % W, y = (c / W) | 0;
    let cnt = 0;
    if (y > 0 && open[c - W] === 1) nb[cnt++] = c - W;
    if (x > 0 && open[c - 1] === 1) nb[cnt++] = c - 1;
    if (x < W - 1 && open[c + 1] === 1) nb[cnt++] = c + 1;
    if (y < H - 1 && open[c + W] === 1) nb[cnt++] = c + W;
    if (cnt < 2) continue;             /* 死端/孤立格不在环上 */
    const stamp = c + 1;
    let qh = 0, qt = 0, found = false;
    q[qt++] = nb[0];
    vis[nb[0]] = stamp;
    while (qh < qt && !found) {
      const u = q[qh++];
      const ux = u % W, uy = (u / W) | 0;
      for (let d = 0; d < 4; d++) {
        let v = -1;
        if (d === 0 && uy > 0) v = u - W;
        else if (d === 1 && ux > 0) v = u - 1;
        else if (d === 2 && ux < W - 1) v = u + 1;
        else if (d === 3 && uy < H - 1) v = u + W;
        if (v < 0 || open[v] !== 1 || v === c || vis[v] === stamp) continue;
        vis[v] = stamp;
        if (v === nb[1] || (cnt > 2 && v === nb[2]) || (cnt > 3 && v === nb[3])) {
          found = true;
          break;
        }
        q[qt++] = v;
      }
    }
    ring[c] = found ? 1 : 0;
  }
  return ring;
}