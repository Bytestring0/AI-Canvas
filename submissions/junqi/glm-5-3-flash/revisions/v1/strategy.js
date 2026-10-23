// =====================================================================
// junqi-2 将军棋策略 —— 单文件、零依赖、完全确定性
//
// 每 tick 流水线:
//   1) 记忆更新: 把当前视野写入持久 belief(顶层 TypedArray, 跨 tick 保留)
//   2) 威胁评估: 从己方将军 BFS, 检测逼近的敌方大部队
//   3) 主力任务机(优先级): 反杀/拦截/回防 > 斩首与夺城(Dijkstra 代价场)
//      > 扩张(最近可占空格) > 回家补给
//   4) 剩余编制: 邻格捡漏 / 弱敌骚扰 / 闲置兵团扩张或收拢
// 不使用任何非确定性输入(随机数/时钟等), 随机源为 seed+id 驱动的 mulberry32。
// =====================================================================

// ---------- 顶层持久状态(每个对局独立初始化, 跨 tick 保留) ----------
let S = null;

// ---------------- 确定性工具 ----------------
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function tileJitter(v) { // 每格固定微扰, 让路径分流且保持确定性
  return (((v * 2654435761) >>> 0) % 97) * 0.0008;
}

// ---------------- 二叉小根堆(扁平预分配, 零垃圾) ----------------
function heapReset() {
  if (!S.hC) { S.hC = new Float64Array(S.N * 8 + 256); S.hN = new Int32Array(S.N * 8 + 256); }
  S.hSize = 0;
}
function heapPush2(c, n) {
  if (S.hSize >= S.hC.length) return;
  let i = S.hSize++;
  const hC = S.hC, hN = S.hN;
  hC[i] = c; hN[i] = n;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hC[p] <= hC[i]) break;
    const tc = hC[p]; hC[p] = hC[i]; hC[i] = tc;
    const tn = hN[p]; hN[p] = hN[i]; hN[i] = tn;
    i = p;
  }
}
function heapPop2() {
  const hC = S.hC, hN = S.hN, size = --S.hSize;
  const topN = hN[0];
  if (size > 0) {
    hC[0] = hC[size]; hN[0] = hN[size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < size && hC[l] < hC[m]) m = l;
      if (r < size && hC[r] < hC[m]) m = r;
      if (m === i) break;
      const tc = hC[m]; hC[m] = hC[i]; hC[i] = tc;
      const tn = hN[m]; hN[m] = hN[i]; hN[i] = tn;
      i = m;
    }
  }
  return topN;
}

// ---------------- 小工具 ----------------
function gNow(t) { return 1 + ((t / 200) | 0); }
function isEnemyP(ow) { return ow >= 0 && ow < 20 && ow !== S.me && S.teams[ow] !== S.team; }
function isAllyP(ow) { return ow >= 0 && ow < 20 && ow !== S.me && S.teams[ow] === S.team; }
function inFieldXY(x, y) { return x >= 1 && y >= 1 && x <= S.W - 2 && y <= S.H - 2; }

// ---------------- 状态初始化(换局检测) ----------------
function ensureState(o) {
  const key = o.seed + '|' + o.you.id + '|' + o.width + 'x' + o.height + '|' + o.playerCount + '|' + o.maxTicks;
  if (S && S.key === key) return;
  const N = o.width * o.height;
  S = {
    key, W: o.width, H: o.height, N,
    me: o.you.id, team: o.you.team,
    gen: o.you.general.y * o.width + o.you.general.x,
    kOwner: new Int16Array(N).fill(-2),  // 最后可见归属
    kArmy: new Int32Array(N).fill(-1),   // 最后可见兵力
    kTick: new Int32Array(N).fill(-1),   // 最后可见 tick
    gens: new Int16Array(N).fill(-1),    // -1 无 / -2 归属不明 / -3 队友将 / >=0 敌方玩家 id
    fTick: new Int32Array(N).fill(-1),   // 首次目击 tick
    guess: new Int16Array(20).fill(-1),  // 各敌方玩家腹地推断格
    genKnown: new Int8Array(20),         // 该敌将位置是否已知
    terrF: new Int8Array(N),             // 本 tick 地形扁平缓存
    bOwn: new Int16Array(N),             // 信念归属(含视野外估计)
    bArm: new Int32Array(N),             // 信念兵力(敌方按增长率外推)
    bVis: new Int8Array(N),              // 当前是否可见
    danger: new Int32Array(N),           // 可见敌大部队 8 邻域强度
    teams: new Int8Array(20).fill(-1),
    aliveP: new Int8Array(20),
    pArmy: new Int32Array(20),
    pLand: new Int32Array(20),
    teamArmy: new Float64Array(8),
    myRank: 1, enemyTeams: 0,
    plan: null,                          // {task, target, since} 任务黏滞
    alert: 0,                            // 防御警戒剩余 tick
    rng: hashStr(o.seed + '|' + o.you.id),
    myLand: 0, myTotal: 0,
    homeDist: null,
  };
}

// ---------------- 地形扁平化 ----------------
function buildStaticTerrain(o) {
  const W = S.W;
  for (let y = 0; y < S.H; y++) {
    const row = o.terrain[y], base = y * W;
    for (let x = 0; x < W; x++) S.terrF[base + x] = row[x];
  }
}

// ---------------- 记忆更新: 吸收本 tick 视野 ----------------
function updateKnowledge(o) {
  const W = S.W, t = o.tick, me = S.me, myTeam = S.team;
  for (let p = 0; p < o.players.length; p++) {
    const pl = o.players[p];
    if (pl.id >= 0 && pl.id < 20) {
      S.teams[pl.id] = pl.team;
      S.aliveP[pl.id] = pl.alive ? 1 : 0;
      S.pArmy[pl.id] = pl.army;
      S.pLand[pl.id] = pl.land;
      if (pl.id === me) { S.myLand = pl.land; S.myTotal = pl.army; }
    }
  }
  const kO = S.kOwner, kA = S.kArmy, kT = S.kTick, gens = S.gens;
  for (let y = 0; y < S.H; y++) {
    const rO = o.owner[y], rA = o.army[y], rT = o.terrain[y], base = y * W;
    for (let x = 0; x < W; x++) {
      const ow = rO[x];
      if (ow === -2) continue; // 本 tick 不可见
      const i = base + x;
      kO[i] = ow; kA[i] = rA[x]; kT[i] = t;
      if (S.fTick[i] < 0) S.fTick[i] = t; // 首次目击时刻(推断敌方腹地用)
      const tr = rT[x];
      if (i !== S.gen && tr === 3) {
        if (ow >= 0) {
          if (ow === me || S.teams[ow] === myTeam) gens[i] = -3;
          else gens[i] = ow;
        } else if (gens[i] === -1) gens[i] = -2;
      } else if (tr !== 3 && gens[i] !== -1) {
        gens[i] = -1; // 记录的将军格已不再是将军(陷落成城)
      }
    }
  }
}

// ---------------- 敌方腹地推断(最早目击的格子靠近其将军) ----------------
function computeGuess() {
  S.guess.fill(-1);
  S.genKnown.fill(0);
  const fT = S.fTick, bO = S.bOwn, gens = S.gens;
  for (let i = 0; i < S.N; i++) {
    const g = gens[i];
    if (g >= 0 && S.aliveP[g]) S.genKnown[g] = 1;
    const p = bO[i];
    if (p < 0 || p === S.me || S.teams[p] === S.team || !S.aliveP[p]) continue;
    const f = fT[i];
    if (f < 0) continue;
    if (S.guess[p] < 0 || f < fT[S.guess[p]]) S.guess[p] = i;
  }
}

// ---------------- 信念: 视野外兵力按增长率外推 ----------------
function buildBelief(o) {
  const N = S.N, t = o.tick, g = gNow(t);
  const kO = S.kOwner, kA = S.kArmy, kT = S.kTick;
  const bO = S.bOwn, bA = S.bArm, bV = S.bVis, trF = S.terrF, alive = S.aliveP;
  for (let i = 0; i < N; i++) {
    if (kT[i] === t) {
      bV[i] = 1; bO[i] = kO[i]; bA[i] = kA[i];
    } else {
      bV[i] = 0; bO[i] = kO[i];
      let a = kA[i];
      if (a >= 0) {
        const ow = kO[i];
        if (ow >= 0 && ow < 20 && alive[ow]) {
          const dt = t - kT[i];
          const tr = trF[i];
          const rate = (tr === 2 || tr === 3) ? 1 : 0.3; // 城/将每 tick 产, 普通地摊薄
          a = a + ((dt * g * rate) | 0);
        }
      }
      bA[i] = a;
    }
  }
}

// ---------------- 危险图 + 可见最大敌兵团 ----------------
function buildDanger(o) {
  const W = S.W, danger = S.danger, bV = S.bVis, bO = S.bOwn, bA = S.bArm;
  danger.fill(0);
  let maxVis = 0;
  for (let y = 1; y < S.H - 1; y++) {
    const base = y * W;
    for (let x = 1; x < W - 1; x++) {
      const i = base + x;
      if (!bV[i] || !isEnemyP(bO[i])) continue;
      const a = bA[i];
      if (a > maxVis) maxVis = a;
      if (a < 10) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const row = i + dy * W;
        for (let dx = -1; dx <= 1; dx++) {
          const j = row + dx;
          if (j >= 0 && j < S.N && a > danger[j]) danger[j] = a;
        }
      }
    }
  }
  S.maxVisEnemy = maxVis;
}

// ---------------- BFS 距离场(4 向, 山与边界不通) ----------------
const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];
function bfsField(src, maxD, buf) {
  const W = S.W, H = S.H, trF = S.terrF;
  buf.fill(-1);
  if (!S.bfsQ) S.bfsQ = new Int32Array(S.N);
  const q = S.bfsQ;
  let qh = 0, qt = 0;
  buf[src] = 0; q[qt++] = src;
  while (qh < qt) {
    const u = q[qh++], d = buf[u];
    if (d >= maxD) continue;
    const ux = u % W, uy = (u / W) | 0;
    for (let k = 0; k < 4; k++) {
      const vx = ux + DX4[k], vy = uy + DY4[k];
      if (vx < 1 || vy < 1 || vx >= W - 1 || vy >= H - 1) continue;
      const v = vy * W + vx;
      if (buf[v] >= 0 || trF[v] === 1) continue;
      buf[v] = d + 1; q[qt++] = v;
    }
  }
  return buf;
}

// ---------------- 沿距离场下山(走向目标) ----------------
function downhillPath(field, src, dst) {
  if (src === dst) return [];
  const W = S.W, H = S.H, trF = S.terrF;
  const path = [];
  let cur = src, guard = 0;
  while (cur !== dst && guard++ < 4000) {
    const cx = cur % W, cy = (cur / W) | 0;
    let best = -1, bd = field[cur];
    for (let k = 0; k < 4; k++) {
      const vx = cx + DX4[k], vy = cy + DY4[k];
      if (vx < 1 || vy < 1 || vx >= W - 1 || vy >= H - 1) continue;
      const v = vy * W + vx;
      if (trF[v] === 1) continue;
      const d = field[v];
      if (d >= 0 && d < bd) { bd = d; best = v; }
    }
    if (best < 0) break;
    path.push(best); cur = best;
  }
  return cur === dst ? path : null;
}

// ---------------- Dijkstra(代价场 + 前驱, 缓冲区复用) ----------------
function dijkstra(src, costFn, limit) {
  const N = S.N, W = S.W, H = S.H;
  if (!S.dist) { S.dist = new Float64Array(N); S.prev = new Int32Array(N); }
  const dist = S.dist, prev = S.prev;
  dist.fill(Infinity); prev.fill(-1);
  heapReset();
  dist[src] = 0;
  heapPush2(0, src);
  while (S.hSize) {
    const u = heapPop2();
    const d = dist[u];
    if (dist[u] === Infinity || d > limit) continue;
    const ux = u % W, uy = (u / W) | 0;
    for (let k = 0; k < 4; k++) {
      const vx = ux + DX4[k], vy = uy + DY4[k];
      if (vx < 1 || vy < 1 || vx >= W - 1 || vy >= H - 1) continue;
      const v = vy * W + vx;
      const c = costFn(v);
      if (c === Infinity) continue;
      const nd = d + c;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heapPush2(nd, v); }
    }
  }
  return { dist, prev };
}
function pathTo(prev, src, dst) {
  if (dst === src) return [];
  if (prev[dst] < 0) return null;
  const path = [];
  let cur = dst, guard = 0;
  while (cur !== src && guard++ < 5000) {
    path.push(cur);
    cur = prev[cur];
    if (cur < 0) return null;
  }
  path.reverse();
  return path;
}
function dirStep(px, py, nx, ny) {
  if (ny === py) { if (nx === px + 1) return 'right'; if (nx === px - 1) return 'left'; }
  if (nx === px) { if (ny === py + 1) return 'down'; if (ny === py - 1) return 'up'; }
  return null;
}

// ---------------- 进攻代价场 ----------------
// stackArmy: 己方出击兵团规模, 用于避开敌方大部队邻域
function makeCostAttack(stackArmy) {
  const W = S.W, H = S.H, trF = S.terrF, bO = S.bOwn, bA = S.bArm, danger = S.danger;
  const avoid = Math.max(30, (stackArmy || 60) * 0.6);
  return function (v) {
    const tr = trF[v];
    if (tr === 1) return Infinity;
    const x = v % W, y = (v / W) | 0;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return Infinity;
    const ow = bO[v];
    let c;
    if (ow === S.me) c = 0.35;
    else if (ow >= 0) {
      if (S.teams[ow] === S.team) return 0.6;
      let a0 = bA[v];
      if (a0 < 0) a0 = 5;
      if (a0 > 90) return Infinity;
      c = tr === 2 || tr === 3 ? 4 + a0 * 1.7 : 2.5 + a0 * 1.4;
    } else if (ow === -2) c = 2.5;
    else c = tr === 2 ? 75 : 1;
    if (danger[v] >= avoid) c *= 6;
    return c;
  };
}

// ---------------- 链式移动(带虚拟结算, 最多 maxSteps 步) ----------------
// firstHalf: 第一条移动用 half:true(发送 floor(n/2)), 用于将军大堆留半守家
function emitChain(moves, src, army, path, maxSteps, budget, firstHalf) {
  const W = S.W, kT = S.kTick, bO = S.bOwn, bA = S.bArm;
  let pos = src, a = army, steps = 0;
  let first = !!firstHalf;
  for (let pi = 0; pi < path.length && steps < maxSteps && moves.length < budget; pi++) {
    const nxt = path[pi];
    const tr = S.terrF[nxt];
    if (tr === 1) break;
    const px = pos % W, py = (pos / W) | 0, nx = nxt % W, ny = (nxt / W) | 0;
    const dir = dirStep(px, py, nx, ny);
    if (!dir) break;
    const a0 = a;
    const k = first ? ((a0 / 2) | 0) : (a0 - 1);
    if (k < 1) break;
    const ow = bO[nxt];
    const unseen = kT[nxt] < S.tickNow - 3; // 陈旧情报要求更大冗余
    if (ow === S.me || isAllyP(ow)) {
      const m = bA[nxt] >= 0 ? bA[nxt] : 0;
      moves.push({ from: { x: px, y: py }, dir: dir, half: first });
      a = k + m;
      bA[nxt] = a;
    } else {
      let def = bA[nxt] >= 0 ? bA[nxt] : (tr === 2 ? 45 : 3);
      if (tr === 2 && ow === -1 && def < 40) def = 40;
      if (k <= def) break;
      if (unseen && k < def * 1.5 + 4) break;
      moves.push({ from: { x: px, y: py }, dir: dir, half: first });
      a = k - def;
      bO[nxt] = S.me;
      bA[nxt] = a;
    }
    if (bO[pos] === S.me) bA[pos] = first ? (a0 - k) : 1;
    else bA[pos] = Math.max(0, bA[pos] - k);
    pos = nxt; steps++;
    first = false;
    if (kT[nxt] < 0 && ow === -2 && a < 60) break; // 小兵团踏入未知后停止本 tick 链(防误判)
  }
  return { pos, army: a };
}

// ---------------- 收集己方可动兵团 ----------------
function collectStacks(o) {
  const W = S.W, me = S.me, list = [];
  for (let y = 1; y < S.H - 1; y++) {
    const rO = o.owner[y], rA = o.army[y], base = y * W;
    for (let x = 1; x < W - 1; x++) {
      if (rO[x] === me && rA[x] >= 2) list.push({ i: base + x, a: rA[x] });
    }
  }
  list.sort(function (p, q) { return q.a - p.a; });
  return list;
}

// ---------------- 威胁评估 ----------------
function computeThreat(o) {
  if (!S.threatDist) S.threatDist = new Int32Array(S.N);
  const dist = bfsField(S.gen, 16, S.threatDist);
  const W = S.W, bV = S.bVis, bO = S.bOwn, bA = S.bArm;
  let maxW = 0, big = -1, bigD = 0;
  for (let y = 1; y < S.H - 1; y++) {
    const rO = o.owner[y], rA = o.army[y], base = y * W;
    for (let x = 1; x < W - 1; x++) {
      const ow = rO[x];
      if (ow < 0 || ow === S.me || S.teams[ow] === S.team) continue;
      const a = rA[x];
      if (a < 6) continue;
      const i = base + x, d = dist[i];
      if (d < 0 || d > 16) continue;
      const w = a / (1 + d * 0.4);
      if (w > maxW) { maxW = w; big = i; bigD = d; }
    }
  }
  const genArmy = bA[S.gen] >= 0 ? bA[S.gen] : 1;
  const bigArmy = big >= 0 ? bA[big] : 0;
  const danger = maxW >= genArmy * 0.7 + 2 ||
    (big >= 0 && bigD <= 2 && bigArmy >= genArmy * 0.55 + 2) ||
    (big >= 0 && bigD <= 5 && bigArmy >= 14);
  return { danger: danger, big: big, bigD: bigD, bigArmy: bigArmy, genArmy: genArmy, dist: dist, maxW: maxW };
}

// ---------------- 进攻目标搜索(敌将 / 敌城 / 中立城 / 敌腹地) ----------------
function findOffense(o, src, army, isGenPile) {
  const remain = o.maxTicks - o.tick;
  const g = gNow(o.tick);
  let thr = 12;
  if (o.tick < 30) thr = 55;
  else if (S.myRank === 1 && remain < o.maxTicks * 0.12) thr = 60;
  else if (S.myRank > 1 && remain < o.maxTicks * 0.22) thr = -25;
  if (army < 12) return null; // 兵力太少, 进攻搜索没有意义
  if (isGenPile && S.myLand < 22 && o.tick < o.maxTicks * 0.15 && thr > 0) return null;
  const res = dijkstra(src, makeCostAttack(army), isGenPile ? 60 : 320);
  const dist = res.dist, prev = res.prev;
  let best = null;
  for (let i = 0; i < S.N; i++) {
    const d = dist[i];
    if (!(d < Infinity) || d <= 0) continue;
    const tr = S.terrF[i], ow = S.bOwn[i];
    let value = 0, entry = 0;
    if (tr === 3 && i !== S.gen) {
      const gOwn = S.gens[i];
      if (gOwn === -3) continue;
      let tt = 60;
      if (gOwn >= 0) { if (!S.aliveP[gOwn]) continue; tt = S.pArmy[gOwn]; }
      else {
        tt = 0;
        for (let p = 0; p < 20; p++) if (S.aliveP[p] && isEnemyP(p) && S.pArmy[p] > tt) tt = S.pArmy[p];
        if (tt === 0) tt = 60;
      }
      value = 135 + Math.max(0, 70 - tt) * 1.3;
      entry = 4 + Math.max(5, S.bArm[i] >= 0 ? S.bArm[i] : 30) * 1.7;
    } else if (tr === 2 && isEnemyP(ow)) {
      if (!S.aliveP[ow]) continue;
      value = 45;
      entry = 4 + Math.max(5, S.bArm[i] >= 0 ? S.bArm[i] : 30) * 1.7;
    } else if (tr === 2 && ow === -1) {
      const def = S.bArm[i] >= 0 ? S.bArm[i] : 45;
      if (def > 55) continue;
      value = Math.min(52, 12 + remain * g * 0.06);
      entry = 75;
    } else if (ow >= 0 && isEnemyP(ow) && S.guess[ow] === i && !S.genKnown[ow]) {
      value = 80; // 敌方腹地: 顺路扫平其核心, 逼近后通常能目击真将军
      entry = 2.5 + Math.max(1, S.bArm[i] >= 0 ? S.bArm[i] : 3) * 1.4;
    } else continue;
    if (isGenPile && d > 36) continue;
    if (isGenPile && tr === 2 && ow === -1 && d > 14) continue;
    if (d + 2 > army) continue;
    if (S.danger[i] >= army && tr !== 3) continue;
    const dd = d - entry; // 评分扣除进入目标格自身的代价
    let score = value - Math.max(0, dd) * 1.1;
    if (S.plan && S.plan.target === i) score += 7;
    if (!best || score > best.score) best = { target: i, score: score };
  }
  if (!best || best.score < thr) return null;
  const path = pathTo(prev, src, best.target);
  if (!path || !path.length) return null;
  return { task: 'ATK', target: best.target, path: path, score: best.score };
}

// ---------------- 前沿磨地: 统一的扩张/侦察/吞地搜索 ----------------
function makeCostFrontier(army) {
  const W = S.W, H = S.H, trF = S.terrF, bO = S.bOwn, bA = S.bArm, danger = S.danger;
  const avoid = Math.max(30, army * 0.6);
  return function (v) {
    const tr = trF[v];
    if (tr === 1) return Infinity;
    const x = v % W, y = (v / W) | 0;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return Infinity;
    const ow = bO[v];
    let c;
    if (ow === S.me) c = 0.35;
    else if (ow >= 0) {
      if (S.teams[ow] === S.team) return 0.6;
      let a0 = bA[v];
      if (a0 < 0) a0 = 5;
      if (a0 > 90) return Infinity;           // 敌大堆不撞
      c = 2.5 + a0 * 1.4;
    } else if (ow === -2) c = 3 + tileJitter(v);   // 未知格: 侦察代价 + 固定微扰
    else c = (tr === 2 ? 75 : 1) + tileJitter(v);   // 中立城高代价绕行
    if (danger[v] >= avoid) c *= 6;                 // 避开敌方大部队邻域
    return c;
  };
}
function findFrontier(o, src, army) {
  const res = dijkstra(src, makeCostFrontier(army), 200);
  const dist = res.dist, prev = res.prev;
  const bO = S.bOwn, trF = S.terrF, kT = S.kTick, bA = S.bArm;
  let best = null;
  for (let i = 0; i < S.N; i++) {
    const d = dist[i];
    if (!(d < Infinity) || d <= 0) continue;
    const tr = trF[i], ow = bO[i];
    let value = 0, entry = 0;
    if (ow === -1 && tr === 0 && bA[i] === 0) { value = 30; entry = 1; }          // 中立空地
    else if (ow === -2 && kT[i] < 0 && tr === -1) { value = 26; entry = 3; }      // 未知格(侦察)
    else if (ow >= 0 && isEnemyP(ow) && tr !== 2 && tr !== 3) {                    // 敌方土地(吞地)
      const et = S.teams[ow];
      if (et < 0 || et >= 8 || S.teamArmy[et] > S.teamArmy[S.team] * 1.5) continue;
      value = 24;
      entry = 2.5 + Math.max(1, bA[i] >= 0 ? bA[i] : 3) * 1.4;
    } else continue;
    if (S.danger[i] >= army) continue;
    if (d + 2 > army) continue;
    const dd = Math.max(0, d - entry);
    let score = value - dd * 1.1;
    if (S.plan && S.plan.target === i) score += 5;
    if (!best || score > best.score) best = { target: i, score: score };
  }
  if (!best || best.score < 8) return null;
  const path = pathTo(prev, src, best.target);
  if (!path || !path.length) return null;
  return { task: 'FRONT', target: best.target, path: path, score: best.score };
}

// ---------------- 宏观态势(队伍军力排名) ----------------
function macro(o) {
  S.teamArmy.fill(0);
  for (let p = 0; p < o.players.length; p++) {
    const pl = o.players[p];
    if (!pl.alive) continue;
    if (pl.team >= 0 && pl.team < 8) S.teamArmy[pl.team] += pl.army;
  }
  const mine = S.teamArmy[S.team];
  let rank = 1, enemies = 0, maxEnemy = 0;
  for (let t = 0; t < 8; t++) {
    if (t === S.team) continue;
    if (S.teamArmy[t] > 0) {
      enemies++;
      if (S.teamArmy[t] > mine) rank++;
      if (S.teamArmy[t] > maxEnemy) maxEnemy = S.teamArmy[t];
    }
  }
  S.myRank = rank;
  S.enemyTeams = enemies;
  S.maxEnemyTeam = maxEnemy;
}

// ---------------- 防御: 反杀 / 拦截 / 收拢 ----------------
function defend(o, threat, moves, stacks) {
  const budget = 4;
  // A) 将军反杀邻格弱敌
  if (threat.bigD <= 1 && threat.bigArmy < threat.genArmy - 1) {
    emitChain(moves, S.gen, threat.genArmy, [threat.big], 1, budget);
    if (moves.length) return;
  }
  // B) 野战主力前出拦截(能在半路吃掉威胁时尽早出手)
  if (threat.big >= 0 && threat.bigD <= 8) {
    let bestS = null;
    for (let i = 0; i < stacks.length; i++) {
      const s = stacks[i];
      if (s.i === S.gen) continue;
      if (s.a > threat.bigArmy + threat.bigD + 3 && (!bestS || s.a > bestS.a)) bestS = s;
    }
    if (bestS) {
      const res = dijkstra(threat.big, makeCostAttack(bestS.a * 2), 30);
      const p = pathTo(res.prev, threat.big, bestS.i);
      if (p) {
        p.reverse();
        emitChain(moves, bestS.i, S.bArm[bestS.i] >= 2 ? S.bArm[bestS.i] : bestS.a, p, budget, budget);
        if (moves.length) return;
      }
    }
  }
  // C) 收拢回防: 最大的兵团全速赶回, 其余各走一步
  let first = true;
  for (let i = 0; i < stacks.length && moves.length < budget; i++) {
    const s = stacks[i];
    if (s.i === S.gen) continue;
    const d0 = S.homeDist[s.i];
    if (d0 < 0 || d0 > 30) continue;
    const a = S.bArm[s.i] >= 2 ? S.bArm[s.i] : s.a;
    if (a < 2) continue;
    const p = downhillPath(S.homeDist, s.i, S.gen);
    if (p && p.length) {
      emitChain(moves, s.i, a, p, first ? budget - moves.length : 1, budget);
      first = false;
    }
  }
}

// ---------------- 守家底线: 估计敌方可能组成的最大兵团 ----------------
function guardFloor() {
  let f = Math.max(30, (S.maxVisEnemy || 0) * 0.8, S.maxEnemyTeam * 0.1);
  return Math.min(f, S.myTotal * 0.5);
}

// ---------------- 主力任务机 ----------------
function runPrimary(o, stacks, moves, threat) {
  const budget = 4;
  const reserve = stacks.length >= 10 ? 1 : 0;
  const maxSteps = Math.max(1, budget - reserve);
  let genS = null, field = null;
  for (let i = 0; i < stacks.length; i++) {
    if (stacks[i].i === S.gen) genS = stacks[i];
    else if (!field) field = stacks[i];
  }
  const early = S.myLand < 22 && o.tick < o.maxTicks * 0.15;
  const gf = guardFloor();
  let primary = null;
  if (field && genS) {
    if (genS.a < gf) primary = field;                      // 守家底线未达标: 大堆留守
    else primary = (genS.a > field.a * 1.3) ? genS : field; // 明显更大才接管, 防反复半军细流
  } else primary = field || genS;
  if (!primary) return;
  const primaryIsGen = primary.i === S.gen;

  let task = null;
  if (primaryIsGen) task = findOffense(o, primary.i, primary.a, true);
  else task = findOffense(o, primary.i, primary.a, false);
  if (!task && !primaryIsGen && genS && genS.a >= 50 && genS.a >= S.maxEnemyTeam * 0.9) {
    task = findOffense(o, S.gen, genS.a, true);           // 将军大堆全面压制时才倾巢出击
  }
  if (!task && primary.a <= 3) {
    const p = downhillPath(S.homeDist, primary.i, S.gen);
    if (p && p.length) task = { task: 'HOME', target: S.gen, path: p };
  }
  if (!task) task = findFrontier(o, primary.i, primary.a);
  if (!task && primary.a > 3) {
    const p = downhillPath(S.homeDist, primary.i, S.gen);
    if (p && p.length) task = { task: 'HOME', target: S.gen, path: p };
  }
  if (!task) return;
  S.plan = { task: task.task, target: task.target, since: o.tick };
  // 将军大堆扩张时留一半守家(半军出征), 小堆全出
  const firstHalf = primaryIsGen && task.task === 'FRONT' && primary.a >= 40;
  emitChain(moves, primary.i, primary.a, task.path, maxSteps, budget, firstHalf);
}

// ---------------- 剩余编制: 捡漏 / 骚扰 / 扩张 / 收拢 ----------------
function adjacentGrab(o, s) {
  const W = S.W, i = s.i, x = i % W, y = (i / W) | 0;
  let best = -1, bestScore = 0;
  for (let k = 0; k < 4; k++) {
    const nx = x + DX4[k], ny = y + DY4[k];
    if (!inFieldXY(nx, ny)) continue;
    const j = ny * W + nx;
    const tr = S.terrF[j], ow = S.bOwn[j];
    if (tr === 1) continue;
    if (S.danger[j] >= s.a) continue;
    let sc = 0;
    if (ow === -1 && tr === 0 && S.bArm[j] === 0) sc = 2;
    else if (ow === -2 && S.kTick[j] < 0 && s.a >= 55) sc = 1;
    if (sc > bestScore) { bestScore = sc; best = j; }
  }
  return best;
}
function adjacentRaid(o, s) {
  if (o.tick < 45) return -1;
  const W = S.W, i = s.i, x = i % W, y = (i / W) | 0;
  for (let k = 0; k < 4; k++) {
    const nx = x + DX4[k], ny = y + DY4[k];
    if (!inFieldXY(nx, ny)) continue;
    const j = ny * W + nx;
    const ow = S.bOwn[j];
    if (!isEnemyP(ow)) continue;
    const a = S.bArm[j];
    if (a < 0) continue;
    if (s.a <= a + 3) continue;
    const et = S.teams[ow];
    if (et >= 0 && et < 8 && S.teamArmy[et] > S.teamArmy[S.team] * 0.9) continue;
    if (S.danger[j] >= s.a) continue;
    return j;
  }
  return -1;
}
function runExtras(o, stacks, moves) {
  const budget = 4;
  let djk = 0;
  const djkMax = S.N > 20000 ? 2 : 3;
  for (let i = 0; i < stacks.length && moves.length < budget; i++) {
    const s = stacks[i];
    if (s.i === S.gen && s.a >= 20) continue; // 大堆留守
    const a = S.bArm[s.i] >= 2 ? S.bArm[s.i] : s.a; // 主力链可能改写该格
    if (a < 2) continue;
    const grab = adjacentGrab(o, { i: s.i, a: a });
    if (grab >= 0) { emitChain(moves, s.i, a, [grab], 1, budget); continue; }
    const raid = adjacentRaid(o, { i: s.i, a: a });
    if (raid >= 0) { emitChain(moves, s.i, a, [raid], 1, budget); continue; }
    if (a >= 8 && djk < djkMax) {
      djk++;
      const exp = findFrontier(o, s.i, a);
      if (exp) { emitChain(moves, s.i, a, exp.path, budget - moves.length, budget); continue; }
    }
    if (a >= 45) {
      const hd = S.homeDist[s.i];
      if (hd > 22) {
        const p = downhillPath(S.homeDist, s.i, S.gen);
        if (p && p.length) emitChain(moves, s.i, a, p, budget - moves.length, budget);
      }
    }
  }
}

// ---------------- 输出结构校验(防策略错误出局) ----------------
function sanitize(moves) {
  const out = [];
  for (let i = 0; i < moves.length && out.length < 4; i++) {
    const m = moves[i];
    if (!m || !m.from) continue;
    const x = m.from.x, y = m.from.y;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!isFinite(x) || !isFinite(y)) continue;
    if ((x | 0) !== x || (y | 0) !== y) continue;
    if (x < 0 || y < 0 || x >= S.W || y >= S.H) continue;
    if (m.dir !== 'up' && m.dir !== 'down' && m.dir !== 'left' && m.dir !== 'right') continue;
    const mm = { from: { x: x, y: y }, dir: m.dir };
    if (m.half === false) mm.half = false;
    out.push(mm);
  }
  return out;
}

// ---------------- 主入口 ----------------
function decide(o) {
  try {
    if (!o || o.version !== 'junqi-2' || !o.you || !o.you.alive) return { moves: [], memory: null };
    ensureState(o);
    S.tickNow = o.tick;
    if (S.plan && o.tick - S.plan.since > 60) S.plan = null;
    buildStaticTerrain(o);
    updateKnowledge(o);
    buildBelief(o);
    buildDanger(o);
    computeGuess();
    macro(o);
    if (!S.homeDist) S.homeDist = new Int32Array(S.N);
    bfsField(S.gen, 9999, S.homeDist);
    const stacks = collectStacks(o);
    const moves = [];
    const threat = computeThreat(o);
    if (threat.danger) {
      S.alert = 6;
      defend(o, threat, moves, stacks);
    } else if (S.alert > 0) {
      S.alert--;
    }
    if (!threat.danger) {
      runPrimary(o, stacks, moves, threat);
      runExtras(o, stacks, moves);
    }
    return { moves: sanitize(moves), memory: null };
  } catch (e) {
    return { moves: [], memory: null };
  }
}

// ---------------- 初始化期 JIT 预热(用假局面跑几轮, 消除首 tick 编译尖峰) ----------------
(function warmup() {
  try {
    const W = 10, H = 10;
    const terrain = [], owner = [], army = [];
    for (let y = 0; y < H; y++) {
      const rT = [], rO = [], rA = [];
      for (let x = 0; x < W; x++) {
        const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
        rT.push(border ? 1 : (x === 4 && y === 4 ? 2 : 0));
        rO.push(x === 2 && y === 2 ? 0 : -1);
        rA.push(x === 2 && y === 2 ? 9 : 0);
      }
      terrain.push(rT); owner.push(rO); army.push(rA);
    }
    army[4][4] = 42; // 中立城
    const obs = {
      version: 'junqi-2', role: 'player', seed: '__warmup__', tick: 0, maxTicks: 777777,
      width: W, height: H, playerCount: 2,
      you: { id: 0, team: 0, general: { x: 2, y: 2 }, alive: true },
      players: [{ id: 0, team: 0, alive: true, army: 9, land: 1 }, { id: 1, team: 1, alive: true, army: 5, land: 1 }],
      terrain: terrain, owner: owner, army: army, memory: null,
    };
    for (let i = 0; i < 24; i++) {
      obs.tick = i;
      army[2][2] = Math.min(70, 9 + i * 3);
      if (i > 3) { owner[3][3] = 0; army[3][3] = i + 1; }
      if (i > 6) { owner[5][5] = 1; army[5][5] = 3; }
      if (i > 10) { owner[6][6] = 1; army[6][6] = 40; terrain[6][6] = 3; } // 触发敌将分支
      decide(obs);
    }
  } catch (e) { /* 预热失败不影响对局 */ }
})();