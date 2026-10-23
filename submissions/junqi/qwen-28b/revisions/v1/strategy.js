/* 将军棋 (junqi-2) 策略 —— 确定性贪心 + 战争迷雾记忆
 * 无 import/export、无第三方依赖、无随机/时间/网络/DOM。
 * 每 tick: 扫描视野刷新记忆 -> 评估威胁 -> 生成候选移动, 按分值取前 4。
 * 分值优先级: 猎将 100000 > 防御增援 ~5000 > 攻敌方城市 ~2000 > 攻中立城市 ~1500
 *           > 歼敌 500/400 > 扩张 200+。
 */
'use strict';

let W = 0, H = 0, inited = false;
let lastOwner, lastArmy, lastSeen, cellT, wO, wA;
let genPos, teamOf, byId;
let youId = -1, myTeam = -1, pcount = 0;

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0], DN = ['up', 'right', 'down', 'left'];

function isAlly(p) { return p === youId || (p >= 0 && p < pcount && teamOf[p] === myTeam); }
function inB(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }

function init(o) {
  W = o.width; H = o.height;
  const N = W * H;
  lastOwner = new Int16Array(N);
  lastArmy = new Int32Array(N);
  lastSeen = new Int32Array(N).fill(-1);
  cellT = new Int8Array(N);
  wO = new Int16Array(N);
  wA = new Int32Array(N);
  pcount = o.playerCount;
  genPos = new Int32Array(pcount).fill(-1);
  teamOf = new Int32Array(pcount).fill(-1);
  for (let i = 0; i < o.players.length; i++) {
    const p = o.players[i];
    if (p && p.id >= 0 && p.id < pcount) teamOf[p.id] = p.team;
  }
  youId = o.you.id;
  myTeam = o.you.team;
  inited = true;
}

/* 视野扫描: 把当前可见格子的归属/军力写入长期记忆, 记录见过的将军, 清除死亡玩家的将军 */
function scan(o) {
  const t = o.tick;
  byId = new Array(pcount);
  for (let i = 0; i < o.players.length; i++) {
    const p = o.players[i];
    if (p && p.id >= 0 && p.id < pcount) byId[p.id] = p;
  }
  for (let y = 0; y < H; y++) {
    const tr = o.terrain[y], ow = o.owner[y], ar = o.army[y], base = y * W;
    for (let x = 0; x < W; x++) {
      const i = base + x;
      cellT[i] = tr[x];
      const owner = ow[x];
      if (owner !== -2) {
        lastOwner[i] = owner;
        lastArmy[i] = ar[x];
        lastSeen[i] = t;
        if (tr[x] === 3 && owner !== youId && owner >= 0 && owner < pcount) genPos[owner] = i;
      }
    }
  }
  for (let p = 0; p < pcount; p++) {
    if (p !== youId && byId[p] && !byId[p].alive && genPos[p] >= 0) genPos[p] = -1;
  }
}

function plan(o) {
  const t = o.tick, maxT = o.maxTicks;
  wO.fill(-1); wA.fill(0);
  const myX = [], myY = [], myN = [], myT = [];
  for (let y = 0; y < H; y++) {
    const ow = o.owner[y], ar = o.army[y], base = y * W;
    for (let x = 0; x < W; x++) {
      const i = base + x;
      const owner = ow[x];
      if (owner === -2) continue;
      wA[i] = ar[x];
      if (owner === youId || isAlly(owner)) {
        wO[i] = youId;
        if (owner === youId) { myX.push(x); myY.push(y); myN.push(ar[x]); myT.push(cellT[i]); }
      } else {
        wO[i] = owner;
      }
    }
  }

  /* 8 邻域内本 tick 可见敌军的最强兵力; 达到威胁阈值(>=我+4 且 >1.5x我)才返回 */
  function threatA(x, y, self) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!inB(nx, ny)) continue;
      const i = ny * W + nx;
      const ow = lastOwner[i];
      if (ow !== -2 && ow !== -1 && ow !== youId && !isAlly(ow) && lastSeen[i] === t && lastArmy[i] > m) m = lastArmy[i];
    }
    return (m >= self + 4 && m > self * 1.5) ? m : 0;
  }

  const cands = [];
  const mc = myX.length;
  for (let c = 0; c < mc; c++) {
    const x = myX[c], y = myY[c], n = myN[c], tc = myT[c];
    if (n < 2) continue;
    const trA = threatA(x, y, n);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!inB(nx, ny)) continue;
      const i = ny * W + nx;
      const tn = cellT[i];
      if (tn === 1) continue;
      const owner = wO[i], a = wA[i];
      if (owner === youId) continue;
      if (owner === -1) {
        const k = n >> 1;
        if (tn === 2) {
          if (k > a + 1) cands.push({ s: c, x: x, y: y, d: d, half: true, score: 1500 - a, kind: 1, n: n });
        } else if (k > a) {
          cands.push({ s: c, x: x, y: y, d: d, half: true, score: 200 + Math.min(n, 60), kind: 2, n: n });
        }
      } else if (trA === 0) {
        const alive = byId[owner] ? byId[owner].alive : false;
        const isGen = tn === 3 && genPos[owner] === i;
        const k2 = n >> 1, kf = n - 1;
        if (isGen && alive) {
          if (k2 > a) cands.push({ s: c, x: x, y: y, d: d, half: true, score: 100000, kind: 3, n: n });
        } else if (tn === 2) {
          if (k2 > a + 1) cands.push({ s: c, x: x, y: y, d: d, half: true, score: 2000 - a, kind: 1, n: n });
          else if (tc !== 3 && kf > a + 1 && n > a + 25) cands.push({ s: c, x: x, y: y, d: d, half: false, score: 1800 - a, kind: 1, n: n });
        } else {
          if (k2 > a + 2) cands.push({ s: c, x: x, y: y, d: d, half: true, score: 500, kind: 4, n: n });
          else if (kf > a + 1 && tc !== 3 && t < maxT - 150) cands.push({ s: c, x: x, y: y, d: d, half: false, score: 400, kind: 4, n: n });
        }
      }
    }
  }

  /* 防御增援: 找受威胁最重的己方格, 由相邻且自身不受威胁的己方格派出半数兵力 */
  let worstC = -1, worstA = 0;
  for (let c = 0; c < mc; c++) {
    const m = threatA(myX[c], myY[c], myN[c]);
    if (m > worstA) { worstA = m; worstC = c; }
  }
  if (worstC >= 0) {
    const cx = myX[worstC], cy = myY[worstC];
    let bdI = -1, bdN = 0, bdX = 0, bdY = 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (!inB(nx, ny)) continue;
      const i = ny * W + nx;
      if (wO[i] === youId && wA[i] >= 2 && wA[i] > bdN && threatA(nx, ny, wA[i]) === 0) {
        bdN = wA[i]; bdI = i; bdX = nx; bdY = ny;
      }
    }
    if (bdI >= 0) {
      let dd = 0;
      for (let d = 0; d < 4; d++) if (bdX + DX[d] === cx && bdY + DY[d] === cy) { dd = d; break; }
      cands.push({ s: -1, x: bdX, y: bdY, d: dd, half: true, score: 5000 - worstA, kind: 5, n: bdN });
    }
  }

  cands.sort(function (u, v) { return v.score - u.score; });
  const moves = [];
  const used = {};
  let chained = false;
  for (let i = 0; i < cands.length && moves.length < 4; i++) {
    const cd = cands[i];
    if (used[cd.s]) continue;
    used[cd.s] = 1;
    moves.push({ from: { x: cd.x, y: cd.y }, dir: DN[cd.d], half: cd.half });
    /* 扩张链: "推入中立空地"被选中且出发格兵力>=8时, 紧接一条从新占格再推一步的指令 */
    if (!chained && cd.kind === 2 && cd.n >= 8 && moves.length < 4) {
      chained = true;
      const nx = cd.x + DX[cd.d], ny = cd.y + DY[cd.d];
      for (let d2 = 0; d2 < 4; d2++) {
        const xx = nx + DX[d2], yy = ny + DY[d2];
        if (!inB(xx, yy)) continue;
        const i2 = yy * W + xx;
        if (cellT[i2] === 0 && wO[i2] === -1 && wA[i2] <= 0) {
          moves.push({ from: { x: nx, y: ny }, dir: DN[d2], half: true });
          break;
        }
      }
    }
  }
  return moves;
}

function decide(o) {
  try {
    if (!o || !o.terrain || !o.owner || !o.you) return { moves: [] };
    if (!inited || o.tick === 0 || W !== o.width || H !== o.height || pcount !== o.playerCount) init(o);
    youId = o.you.id;
    myTeam = o.you.team;
    if (!o.you.alive) return { moves: [] };
    scan(o);
    return { moves: plan(o), memory: null };
  } catch (e) {
    return { moves: [] };
  }
}
