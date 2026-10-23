'use strict';

// ============================================================================
// 将军棋（junqi-2）策略 —— “稳扎稳打”
//
// 核心思路：
//   1. 每 tick 从当前观测全量重规划（不保存路径，天然抗干扰、可复现）。
//      模式优先级：斩首（攻敌将）> 保家（将军告急）> 夺城 > 扩张 + 收拢。
//   2. 跨 tick 只持久化“情报”：敌将目击记录（位置/时间/兵力）与斩首冷却，
//      顶层变量与返回值 memory 双保险存储。
//   3. 一 tick 内 4 条指令按序结算、前一条结果对后续可见：所有行军/扩张都用
//      half:false 链式推进（沿途留 1 军守地、顺路吸收己方兵力），单 tick 最多推进 4 格。
//   4. 确定性：不使用 Date/random 等非确定输入，平局按行优先扫描顺序打破。
//   5. 安全：整体 try/catch，任何异常都返回合法的空指令，绝不因格式/异常出局。
// ============================================================================

let S = null; // 跨 tick 持久状态（每局 Worker 独立初始化一次）

function init(o) {
  const w = o.width, h = o.height, n = w * h;
  S = {
    w: w, h: h, n: n,
    me: o.you.id,
    genI: -1,
    TQ: new Int8Array(n),     // 地形扁平副本（已侦察地形由引擎负责记忆）
    OQ: new Int32Array(n),    // 属主：-2 迷雾 / -1 中立 / 玩家 id
    AQ: new Int32Array(n),    // 驻军：-1 迷雾
    EN: new Uint8Array(n),    // 当前可见的敌队格
    AL: new Uint8Array(n),    // 当前可见的队友格
    BLK: new Uint8Array(n),   // 本 tick 内已用/禁用的源格
    dist: new Int32Array(n),  // 通用 BFS 距离
    par: new Int32Array(n),   // 通用 BFS 父指针
    distG: new Int32Array(n), // 己方领地内到将军的距离
    parG: new Int32Array(n),  // 对应父指针（指向将军方向）
    q: new Int32Array(n),     // BFS 队列
    qt: 0,
    gens: Object.create(null),   // pid -> {x,y,t,a}：敌将最后一次被目击
    killCd: Object.create(null), // pid -> 斩首冷却截止 tick
    march: null                  // 进行中的斩首 {pid}
  };
  // 防御性恢复：正常情况下顶层 S 一直在，这里只兜底（如 Worker 被重建）
  const m = o.memory;
  if (m && typeof m === 'object') {
    if (m.gens && typeof m.gens === 'object') {
      for (const k in m.gens) {
        const gi = m.gens[k];
        if (gi && Number.isInteger(gi.x) && Number.isInteger(gi.y)) {
          S.gens[k] = { x: gi.x, y: gi.y, t: gi.t | 0, a: gi.a | 0 };
        }
      }
    }
    if (m.killCd && typeof m.killCd === 'object') {
      for (const k in m.killCd) {
        if (typeof m.killCd[k] === 'number') S.killCd[k] = m.killCd[k] | 0;
      }
    }
  }
}

function memOut() {
  return { gens: S.gens, killCd: S.killCd };
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

function dirOf(a, b) {
  const d = b - a;
  if (d === 1) return 'right';
  if (d === -1) return 'left';
  if (d === S.w) return 'down';
  return 'up';
}

// mode 0：扩张寻路（避开山地/城市/敌将格/可见敌格与队友格）
// mode 1：行军寻路（只避开山地与队友格；借道城市/敌格的费用在推演中扣除）
function bfs(mode, src) {
  const w = S.w, h = S.h;
  const dist = S.dist, par = S.par, q = S.q;
  const TQ = S.TQ, EN = S.EN, AL = S.AL, genI = S.genI;
  dist.fill(-1);
  let qh = 0, qt = 0;
  dist[src] = 0; par[src] = -1; q[qt++] = src;
  while (qh < qt) {
    const c = q[qh++];
    const cx = c % w, cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const t = ny * w + nx;
      if (dist[t] !== -1) continue;
      const tt = TQ[t];
      if (tt === 1) continue;                       // 山地
      if (mode === 0) {
        if (tt === 2) continue;                     // 城市：中立城驻军高，交给夺城逻辑
        if (tt === 3 && t !== genI) continue;       // 敌将格：交给斩首逻辑
        if (EN[t] || AL[t]) continue;               // 可见敌格/队友格
      } else if (AL[t]) {
        continue;                                   // 不把兵力赠予队友格（增援即交出控制权）
      }
      dist[t] = dist[c] + 1;
      par[t] = c;
      q[qt++] = t;
    }
  }
  S.qt = qt;
}

// 在 BFS 访问序列中找第一个“可占领格”：空地/未知地，且非我方、非可见敌格、非队友格
function findExpandTarget() {
  const TQ = S.TQ, OQ = S.OQ, EN = S.EN, AL = S.AL, me = S.me;
  for (let k = 0; k < S.qt; k++) {
    const i = S.q[k];
    const t = TQ[i];
    if ((t === 0 || t === -1) && OQ[i] !== me && !EN[i] && !AL[i]) return i;
  }
  return -1;
}

function buildPath(src, dst) {
  const p = [];
  let c = dst;
  while (c !== src) { p.push(c); c = S.par[c]; }
  p.push(src);
  p.reverse();
  return p; // p[0]=src ... p[len-1]=dst
}

// 未见格守军估计（用于行军推演）
function estDef(i) {
  if (S.OQ[i] === S.me) return 0;
  if (S.AQ[i] >= 0) return S.AQ[i]; // 可见取精确值
  const t = S.TQ[i];
  if (t === 2) return 48;           // 迷雾城市（中立城 40~50）
  if (t === 3) return 40;           // 迷雾敌将（另有专门估计）
  return 1;                         // 迷雾空地
}

// 沿 path 发出至多 maxHops 条指令，并同步本地视图（同一 tick 内后续指令依赖）。
// optimistic=true（扩张）：迷雾格视作 0 守军，1 军也敢去踩（单步损失上限 1）。
// 返回实际发出的指令条数。
function runPath(moves, path, maxHops, firstHalf, optimistic) {
  const w = S.w;
  let head = path[0];
  let army = S.AQ[head];
  let hops = 0;
  for (let s = 1; s < path.length && hops < maxHops; s++) {
    if (army < 2) break;
    const nxt = path[s];
    const half = firstHalf && s === 1;
    const k = half ? (army >> 1) : army - 1;
    if (k < 1) break;
    const own = S.OQ[nxt] === S.me;
    let def = 0;
    if (!own) def = (optimistic && S.AQ[nxt] < 0) ? 0 : estDef(nxt);
    if (!own && k <= def) break; // 预计打不动就止损，不白白送死
    moves.push({ from: { x: head % w, y: (head / w) | 0 }, dir: dirOf(head, nxt), half: half });
    S.AQ[head] = army - k;       // 出发格留下 1（或 half 时的 ceil(n/2)）
    if (own) {
      S.AQ[nxt] = k + S.AQ[nxt]; // 增援并吸收
    } else {
      S.OQ[nxt] = S.me; S.AQ[nxt] = k - def; S.EN[nxt] = 0; S.AL[nxt] = 0;
    }
    army = S.AQ[nxt];
    head = nxt;
    hops++;
  }
  return hops;
}

// 与 runPath 同规则但只推演不发指令；返回到达终点时的兵力，不可行返回 -1
function simArrival(path, firstHalf) {
  let army = S.AQ[path[0]];
  for (let s = 1; s < path.length; s++) {
    if (army < 2) return -1;
    const nxt = path[s];
    const k = (firstHalf && s === 1) ? (army >> 1) : army - 1;
    if (k < 1) return -1;
    const own = S.OQ[nxt] === S.me;
    const def = own ? 0 : estDef(nxt);
    if (!own && k <= def) return -1;
    army = own ? k + S.AQ[nxt] : k - def;
  }
  return army;
}

// 敌将当前守军估计：可见取精确值；否则“目击值 + 经过时间×产量×2”，
// 并以该玩家公开的总军力封顶（将军兵力不可能超过其总军力）。
function genEstimate(pid, tick, g, players) {
  const gi = S.gens[pid];
  if (!gi) return 1e9;
  const cell = gi.y * S.w + gi.x;
  if (S.OQ[cell] === +pid && S.AQ[cell] >= 0) return Math.max(5, S.AQ[cell]);
  const decay = gi.a + (tick - gi.t) * g * 2;
  const total = players[+pid] ? players[+pid].army : 0;
  return Math.max(10, Math.min(decay, total));
}

function decide(o) {
  try {
    if (!S || S.w !== o.width || S.h !== o.height || S.me !== o.you.id) init(o);
    if (!o.you.alive) return { moves: [], memory: memOut() };
    return decideInner(o);
  } catch (e) {
    return { moves: [], memory: null }; // 任何异常都保持合法输出
  }
}

function decideInner(o) {
  const tick = o.tick, w = S.w, h = S.h, n = S.n, me = S.me;
  const TQ = S.TQ, OQ = S.OQ, AQ = S.AQ, EN = S.EN, AL = S.AL;
  const moves = [];

  // ---------- 1) 扁平化与派生标记 ----------
  const teamOf = new Int8Array(o.playerCount);
  for (let p = 0; p < o.players.length; p++) teamOf[o.players[p].id] = o.players[p].team;
  const myTeam = o.you.team;
  let land = 0;
  for (let y = 0; y < h; y++) {
    const rt = o.terrain[y], ro = o.owner[y], ra = o.army[y];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ow = ro[x];
      TQ[i] = rt[x]; OQ[i] = ow; AQ[i] = ra[x];
      if (ow === me) { EN[i] = 0; AL[i] = 0; land++; }
      else if (ow >= 0 && teamOf[ow] === myTeam) { AL[i] = 1; EN[i] = 0; }
      else { AL[i] = 0; EN[i] = ow >= 0 ? 1 : 0; }
    }
  }

  const g = 1 + Math.floor(tick / 200);
  const genX = o.you.general.x, genY = o.you.general.y;
  const genI = genY * w + genX;
  S.genI = genI;
  const genArmy = OQ[genI] === me ? Math.max(0, AQ[genI]) : 0;

  // ---------- 2) 己方领地内到将军的 BFS（防守/收拢用） ----------
  {
    const distG = S.distG, parG = S.parG, q = S.q;
    distG.fill(-1);
    let qh = 0, qt = 0;
    if (OQ[genI] === me) { distG[genI] = 0; parG[genI] = -1; q[qt++] = genI; }
    while (qh < qt) {
      const c = q[qh++];
      const cx = c % w, cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const t = ny * w + nx;
        if (distG[t] !== -1 || OQ[t] !== me) continue;
        distG[t] = distG[c] + 1; parG[t] = c; q[qt++] = t;
      }
    }
  }

  // ---------- 3) 敌将情报维护 ----------
  for (const pid in S.gens) {
    const gi = S.gens[pid];
    const pl = o.players[+pid];
    if (!pl || !pl.alive || pl.team === myTeam) { delete S.gens[pid]; delete S.killCd[pid]; continue; }
    const cell = gi.y * w + gi.x;
    if (OQ[cell] !== -2) { // 该格当前可见：刷新或失效
      if (TQ[cell] === 3 && OQ[cell] === +pid) { gi.t = tick; gi.a = Math.max(0, AQ[cell]); }
      else { delete S.gens[pid]; delete S.killCd[pid]; }
    }
  }
  for (let i = 0; i < n; i++) {
    if (TQ[i] === 3 && EN[i] && OQ[i] >= 0) {
      S.gens[OQ[i]] = { x: i % w, y: (i / w) | 0, t: tick, a: Math.max(0, AQ[i]) };
    }
  }

  // ---------- 4) 威胁评估（敌军逼近我方将军） ----------
  let threatArmy = 0, threatDist = 99, nearSupport = 0;
  for (let i = 0; i < n; i++) {
    const dg = S.distG[i];
    if (dg >= 1 && dg <= 2) nearSupport += Math.max(0, AQ[i]); // 两步内可回援的兵力
    if (!EN[i] || AQ[i] < 8) continue;
    let ed = 99;
    const cx = i % w, cy = (i / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (OQ[j] === me && S.distG[j] >= 0 && S.distG[j] + 1 < ed) ed = S.distG[j] + 1;
    }
    if (ed === 99) ed = Math.max(Math.abs(cx - genX), Math.abs(cy - genY));
    if (ed <= 8 && AQ[i] > threatArmy) { threatArmy = AQ[i]; threatDist = ed; }
  }
  const defendNeeded = threatArmy >= 8 && threatDist <= 8 && (
    (threatDist <= 3 && threatArmy > genArmy + 2) ||
    (threatArmy >= 12 && threatArmy > genArmy + (nearSupport >> 1))
  );

  // ---------- 5) 主力格（我方最大军力格，行军出发点） ----------
  let blob = -1, blobArmy = 0;
  for (let i = 0; i < n; i++) {
    if (OQ[i] === me && AQ[i] > blobArmy) { blobArmy = AQ[i]; blob = i; }
  }

  // ---------- 6) 斩首评估 ----------
  let killMargin = 12;
  if (tick > o.maxTicks - 250) { // 残局：领先求稳、落后搏命
    let maxFoe = 0;
    for (let p = 0; p < o.players.length; p++) {
      const pl = o.players[p];
      if (pl.alive && pl.id !== me && pl.team !== myTeam && pl.army > maxFoe) maxFoe = pl.army;
    }
    const myTot = o.players[me] ? o.players[me].army : 0;
    if (myTot > maxFoe * 1.15) killMargin = 25;
    else if (myTot < maxFoe * 0.85) killMargin = 5;
  }

  let killPlan = null;
  if (blob >= 0 && blobArmy >= 15) {
    const activePid = (S.march && S.gens[S.march.pid] && o.players[+S.march.pid] &&
      o.players[+S.march.pid].alive) ? S.march.pid : null;
    const cands = [];
    const bx = blob % w, by = (blob / w) | 0;
    for (const pid in S.gens) {
      const gi = S.gens[pid];
      const pl = o.players[+pid];
      if (!pl || !pl.alive || pl.team === myTeam) continue;
      // 冷却期内且对方未明显变弱则跳过（对方总军力跌到主力 0.8 倍以下时允许重试）
      if (pid !== activePid && tick < (S.killCd[pid] || 0) && pl.army > blobArmy * 0.8) continue;
      const cheb = Math.max(Math.abs(gi.x - bx), Math.abs(gi.y - by));
      cands.push({ pid: pid, gi: gi, key: pid === activePid ? -1 : cheb });
    }
    cands.sort((a, b) => a.key - b.key);
    if (cands.length > 0) {
      bfs(1, blob); // 一次 BFS 供全部候选使用
      for (let ci = 0; ci < cands.length && ci < 6; ci++) {
        const pid = cands[ci].pid, gi = cands[ci].gi;
        const tI = gi.y * w + gi.x;
        if (S.dist[tI] < 0) continue;
        const path = buildPath(blob, tI);
        const firstHalf = blob === genI && blobArmy >= 30; // 从将军出兵留一半驻军防斩首
        const arrive = simArrival(path, firstHalf);
        if (arrive < 0) continue;
        const est = genEstimate(pid, tick, g, o.players);
        const margin = pid === activePid ? 2 : killMargin; // 已在途中则放宽继续条件
        if (arrive > est + margin && arrive >= 12) {
          killPlan = { path: path, firstHalf: firstHalf, pid: pid, hops: path.length - 1 };
          break;
        }
        // 已逼近仍打不动：冷却 50 tick，防止反复空跑
        if (S.dist[tI] <= 10 && arrive <= est + 3) S.killCd[pid] = tick + 50;
      }
    }
  }

  // ---------- 7) 夺城评估（中立城/敌城；城市 = 每 tick 产的第二个将军） ----------
  let cityPlan = null;
  if (blob >= 0 && blobArmy >= 30) {
    const bx = blob % w, by = (blob / w) | 0;
    const cs = [];
    for (let i = 0; i < n; i++) {
      if (TQ[i] === 2 && OQ[i] !== me && !AL[i]) cs.push(i);
    }
    cs.sort((a, b) =>
      (Math.max(Math.abs(a % w - bx), Math.abs(((a / w) | 0) - by)) + estDef(a) / 8) -
      (Math.max(Math.abs(b % w - bx), Math.abs(((b / w) | 0) - by)) + estDef(b) / 8));
    if (cs.length > 0) {
      bfs(1, blob);
      for (let ci = 0; ci < cs.length && ci < 5; ci++) {
        const tI = cs[ci];
        if (S.dist[tI] < 0) continue;
        const path = buildPath(blob, tI);
        const firstHalf = blob === genI && blobArmy >= 30;
        const arrive = simArrival(path, firstHalf);
        if (arrive < 0) continue;
        const need = estDef(tI) + (EN[tI] ? 14 : 8); // 夺敌城风险更高
        if (arrive > need && arrive >= 8) { cityPlan = { path: path, firstHalf: firstHalf }; break; }
      }
    }
  }

  // ---------- 8) 按优先级执行 ----------
  // 斩首优先；但若将军告急，除非我方将军守得住、或本 tick 就能得手且威胁还远
  if (killPlan && (!defendNeeded || threatArmy <= genArmy || (killPlan.hops <= 4 && threatDist >= 5))) {
    runPath(moves, killPlan.path, 4, killPlan.firstHalf, false);
    S.march = moves.length > 0 ? { pid: killPlan.pid } : null;
    return finish(moves);
  }
  S.march = null;

  if (defendNeeded) {
    defendMoves(moves);
    if (moves.length > 0) return finish(moves);
    // 无兵可收时继续常规运营
  }

  if (cityPlan) {
    runPath(moves, cityPlan.path, 4, cityPlan.firstHalf, false);
    if (moves.length > 0) return finish(moves);
  }

  expandAndGather(moves, tick, land, genI, blob);
  return finish(moves);
}

// 保家：邻接格回填将军 + 附近大格沿父链向将军收拢
function defendMoves(moves) {
  const w = S.w, h = S.h, me = S.me, genI = S.genI;
  const OQ = S.OQ, AQ = S.AQ;
  const gx = genI % w, gy = (genI / w) | 0;
  const adj = [];
  for (let d = 0; d < 4; d++) {
    const nx = gx + DX[d], ny = gy + DY[d];
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const j = ny * w + nx;
    if (OQ[j] === me && AQ[j] >= 2) adj.push(j);
  }
  adj.sort((a, b) => AQ[b] - AQ[a]);
  for (let i = 0; i < adj.length && moves.length < 4; i++) {
    const j = adj[i];
    moves.push({ from: { x: j % w, y: (j / w) | 0 }, dir: dirOf(j, genI), half: false });
    AQ[genI] = AQ[genI] + AQ[j] - 1;
    AQ[j] = 1;
  }
  let guard = 0;
  while (moves.length < 4 && guard++ < 4) {
    let src = -1, best = 2;
    for (let i = 0; i < S.n; i++) {
      if (OQ[i] !== me || i === genI) continue;
      const dg = S.distG[i];
      if (dg < 2 || dg > 10) continue;
      if (AQ[i] > best) { best = AQ[i]; src = i; }
    }
    if (src < 0) break;
    const budget = 4 - moves.length;
    const path = [src];
    let c = src;
    while (c !== genI && path.length <= budget) { c = S.parG[c]; path.push(c); }
    runPath(moves, path, budget, false, false);
  }
}

// 扩张 + 收拢
function expandAndGather(moves, tick, land, genI, blob) {
  const w = S.w, h = S.h, n = S.n, me = S.me;
  const TQ = S.TQ, OQ = S.OQ, AQ = S.AQ, EN = S.EN, AL = S.AL, BLK = S.BLK;
  BLK.fill(0);
  let budget = 4 - moves.length;
  const gatherOn = tick >= 80 || land >= 30;

  // ---- 扩张：优先最大军力格（邻接可占格加成），向最近可占格链式推进 ----
  for (let round = 0; round < 4 && budget > 0; round++) {
    let srcAny = -1, scoreAny = 1;      // 允许用主力
    let srcAlt = -1, scoreAlt = 1;      // 保护主力（>=40 留给行军）
    for (let i = 0; i < n; i++) {
      if (OQ[i] !== me || BLK[i] || AQ[i] < 2) continue;
      let sc = AQ[i];
      const cx = i % w, cy = (i / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const tt = TQ[j];
        if ((tt === 0 || tt === -1) && OQ[j] !== me && !EN[j] && !AL[j]) { sc += 3; break; }
      }
      if (sc > scoreAny) { scoreAny = sc; srcAny = i; }
      if (!(i === blob && AQ[i] >= 40) && sc > scoreAlt) { scoreAlt = sc; srcAlt = i; }
    }
    const src = srcAlt >= 0 ? srcAlt : srcAny;
    if (src < 0) break;
    bfs(0, src);
    const t = findExpandTarget();
    if (t < 0) { BLK[src] = 1; continue; }
    const path = buildPath(src, t);
    const firstHalf = src === genI && AQ[src] >= 12; // 将军出兵留驻军防早期斩首
    const hops = runPath(moves, path, budget, firstHalf, true);
    BLK[src] = 1;
    if (hops <= 0) continue;
    budget -= hops;
  }

  // ---- 收拢：把领地内的富余兵力沿父链送回将军（回收每 25 tick 的土地产出） ----
  if (budget > 0 && gatherOn) {
    let guard = 0;
    while (budget > 0 && guard++ < 4) {
      let src = -1, best = 3;
      for (let i = 0; i < n; i++) {
        if (OQ[i] !== me || i === genI || BLK[i]) continue;
        const dg = S.distG[i];
        if (dg < 2) continue;
        if (AQ[i] > best) { best = AQ[i]; src = i; }
      }
      if (src < 0) break;
      const path = [src];
      let c = src;
      while (c !== genI && path.length <= budget) { c = S.parG[c]; path.push(c); }
      const hops = runPath(moves, path, budget, false, false);
      BLK[src] = 1;
      if (hops <= 0) continue;
      budget -= hops;
    }
  }
}

// 输出净化：字段类型/数量/范围全量校验，保证返回值永远合法
function finish(moves) {
  const out = [];
  if (Array.isArray(moves)) {
    const lim = Math.min(moves.length, 4);
    for (let i = 0; i < lim; i++) {
      const m = moves[i];
      if (!m || typeof m !== 'object') continue;
      const f = m.from;
      if (!f || !Number.isInteger(f.x) || !Number.isInteger(f.y)) continue;
      if (f.x < 0 || f.y < 0 || f.x >= S.w || f.y >= S.h) continue;
      if (m.dir !== 'up' && m.dir !== 'down' && m.dir !== 'left' && m.dir !== 'right') continue;
      out.push({ from: { x: f.x, y: f.y }, dir: m.dir, half: m.half === undefined ? true : !!m.half });
    }
  }
  return { moves: out, memory: memOut() };
}