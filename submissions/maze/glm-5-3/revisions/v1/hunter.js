'use strict';

/* =====================================================================
 * hunter.js — 迷宫竞速 · 追逐策略 (hunter)
 * ---------------------------------------------------------------------
 * 时序模型(与结算规则严格对应):
 *   - 本 tick 结算时玩家先动一格,然后所有追逐者各动一格;
 *   - 伤害只比较双方行动后的最终格,因此"追逐者 d 步外的格子,
 *     最早在相对时刻 (d-1)*hunterEvery 被占据"(第一次移动就发生在
 *     本 tick 结算)。
 *
 * 三种角色(每 tick 按当前观测重新分配,无跨决策状态):
 *   1. 蹲守者(camper):玩家没有钥匙时,离钥匙最近且能先于玩家
 *      到达的追逐者直接驻守钥匙格。拾取钥匙必须踩上该格,
 *      与蹲守者同格即扣血;出口蹲守无意义(成功结算优先于伤害)。
 *   2. 拦截者(interceptor):沿玩家→目标(钥匙/出口)的推测最短路
 *      找"我能不晚于玩家到达"的最早格子,提前占位等待玩家经过。
 *      多个拦截者按路径位置错开(第 r 个从 1+2r 处开始找),
 *      形成沿路径的多点布防。
 *   3. 直追者(chaser):拦不到就 BFS 直追玩家当前位置。
 *      玩家更快(1 格/tick vs 1 格/hunterEvery),直追的意义是
 *      持续施压、逼迫对方绕路、等待其犯错(死胡同/闸门等待)。
 *
 * 走子:按到目标格的 BFS 距离梯度下降;本次移动会被"当前 tick
 * 关闭的闸门"阻挡(用观测里的 closed 布尔,它对应当前结算 tick),
 * 被挡则选择次优可行方向,全被挡则 wait。
 *
 * 完全确定性:固定方向序(up/right/down/left)打破平局;
 * 无 memory、无随机、无时间依赖;异常兜底全员 wait。
 * =================================================================== */

var DIRS = [
  { a: 'up',    dx: 0, dy: -1 },
  { a: 'right', dx: 1, dy: 0 },
  { a: 'down',  dx: 0, dy: 1 },
  { a: 'left',  dx: -1, dy: 0 }
];

var CACHE = null;   /* {seed, W, H, open}:静态墙信息,seed 变化自动重建 */

function decide(o) {
  try {
    return hunt(o);
  } catch (e) {
    const acts = [];
    for (let i = 0; i < o.hunters.length; i++) {
      acts.push({ id: o.hunters[i].id, action: 'wait' });
    }
    return { actions: acts };
  }
}

/* ============================== 主流程 ============================== */

function hunt(o) {
  const W = o.width, H = o.height;
  const N = W * H;
  ensureCache(o, W, H, N);
  const open = CACHE.open;

  const hunters = o.hunters;
  const acts = [];
  if (hunters.length === 0) return { actions: acts };

  const playerCell = o.player.y * W + o.player.x;
  const keyCell = o.key ? (o.key.y * W + o.key.x) : -1;
  const exitCell = o.exit.y * W + o.exit.x;
  const hasKey = o.player.hasKey === true;
  const goal = (hasKey || keyCell < 0) ? exitCell : keyCell;  /* 玩家的推测目的地 */
  const hE = o.hunterEvery;

  /* 玩家→goal 与 goal 的距离场 */
  const gDist = bfsFrom(goal);
  const pDist = bfsFrom(playerCell);

  /* 玩家的推测最短路(按 gDist 梯度下降) */
  const path = [];
  {
    let c = playerCell;
    path.push(c);
    let guard = 0;
    while (c !== goal && guard++ <= N) {
      const x = c % W, y = (c / W) | 0;
      const tgt = gDist[c] - 1;
      let nx = -1;
      if (y > 0 && open[c - W] === 1 && gDist[c - W] === tgt) nx = c - W;
      else if (x > 0 && open[c - 1] === 1 && gDist[c - 1] === tgt) nx = c - 1;
      else if (x < W - 1 && open[c + 1] === 1 && gDist[c + 1] === tgt) nx = c + 1;
      else if (y < H - 1 && open[c + W] === 1 && gDist[c + W] === tgt) nx = c + W;
      if (nx < 0) break;
      c = nx;
      path.push(c);
    }
  }

  /* 本次移动结算时的闸门封闭状态 */
  const gateClosedNow = new Uint8Array(N);
  for (let i = 0; i < o.gates.length; i++) {
    const g = o.gates[i];
    if (g.closed) gateClosedNow[g.y * W + g.x] = 1;
  }

  /* 各追逐者距离场 */
  const hD = [];
  for (let i = 0; i < hunters.length; i++) {
    hD.push(bfsFrom(hunters[i].y * W + hunters[i].x));
  }

  /* 蹲守者:离钥匙最近,且能不晚于玩家 1 tick 以上到达 */
  let camperIdx = -1;
  if (!hasKey && keyCell >= 0) {
    let bestD = -1;
    for (let i = 0; i < hunters.length; i++) {
      const d = hD[i][keyCell];
      if (d >= 0 && (bestD < 0 || d < bestD)) { bestD = d; camperIdx = i; }
    }
    if (camperIdx >= 0) {
      const pKD = pDist[keyCell];
      const hunterArr = bestD <= 0 ? 0 : (bestD - 1) * hE;
      if (pKD < 0 || hunterArr > pKD - 2) camperIdx = -1;   /* 赶不上就不蹲 */
    }
  }

  /* 目标格距离场的调用内缓存 */
  const tdCache = new Map();

  let rank = 0;
  for (let i = 0; i < hunters.length; i++) {
    const h = hunters[i];
    const hCell = h.y * W + h.x;
    let target;

    if (i === camperIdx) {
      /* ---- 蹲守钥匙:玩家要拿钥匙必须踩上来 ---- */
      target = keyCell;
    } else {
      /* ---- 拦截:玩家去路上最早的可行拦截点 ---- */
      target = -1;
      const minS = 1 + rank * 2;   /* 非蹲守者沿路径错位分布 */
      for (let s = minS; s < path.length; s++) {
        const c = path[s];
        if (goal === exitCell && c === exitCell) continue;  /* 出口拦截无意义 */
        const d = hD[i][c];
        if (d < 0) continue;
        const hunterArr = d <= 0 ? 0 : (d - 1) * hE;   /* 相对到达时刻 */
        const playerArr = s - 1;                        /* 玩家到达该格的相对时刻 */
        if (hunterArr <= playerArr) { target = c; break; }
      }
      if (target < 0) target = playerCell;              /* 拦不到就直追 */
      rank++;
    }

    /* ---- 走子:向 target 的 BFS 梯度下降,避开当前关闭闸门 ---- */
    const tD = tdOf(target, tdCache);
    const x = hCell % W, y = (hCell / W) | 0;
    let bestAct = 'wait';
    let bestD = tD[hCell] >= 0 ? tD[hCell] : 100000;
    for (let k = 0; k < 4; k++) {
      const nx = x + DIRS[k].dx, ny = y + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (open[n] !== 1) continue;
      if (gateClosedNow[n] === 1) continue;
      const nd = tD[n];
      if (nd >= 0 && nd < bestD) { bestD = nd; bestAct = DIRS[k].a; }
    }
    acts.push({ id: h.id, action: bestAct });
  }

  return { actions: acts };
}

function tdOf(cell, cache) {
  let v = cache.get(cell);
  if (v === undefined) {
    v = bfsFrom(cell);
    cache.set(cell, v);
  }
  return v;
}

/* ============================== 基础设施 ============================== */

function ensureCache(o, W, H, N) {
  if (CACHE && CACHE.seed === o.seed && CACHE.W === W && CACHE.H === H) return;
  const open = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const row = o.grid[y];
    for (let x = 0; x < W; x++) open[y * W + x] = row[x] === 0 ? 1 : 0;
  }
  CACHE = { seed: o.seed, W: W, H: H, open: open };
}

/* 仅看墙的 BFS(每次调用新建数组;单次 decide 调用次数 ≤ ~9,开销可忽略) */
function bfsFrom(src) {
  const W = CACHE.W, H = CACHE.H, open = CACHE.open;
  const dist = new Int16Array(W * H).fill(-1);
  const q = new Int32Array(W * H);
  let qh = 0, qt = 0;
  dist[src] = 0;
  q[qt++] = src;
  while (qh < qt) {
    const u = q[qh++];
    const d = dist[u] + 1;
    const x = u % W, y = (u / W) | 0;
    if (y > 0 && open[u - W] === 1 && dist[u - W] < 0) { dist[u - W] = d; q[qt++] = u - W; }
    if (y < H - 1 && open[u + W] === 1 && dist[u + W] < 0) { dist[u + W] = d; q[qt++] = u + W; }
    if (x > 0 && open[u - 1] === 1 && dist[u - 1] < 0) { dist[u - 1] = d; q[qt++] = u - 1; }
    if (x < W - 1 && open[u + 1] === 1 && dist[u + 1] < 0) { dist[u + 1] = d; q[qt++] = u + 1; }
  }
  return dist;
}