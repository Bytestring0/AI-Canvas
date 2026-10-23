'use strict';
// 将军棋策略（junqi-2）。同步、确定性、无随机、无时间依赖。
var DX = [0, 1, 0, -1];
var DY = [-1, 0, 1, 0];
var DN = ['up', 'right', 'down', 'left'];
var S = null; // 跨 tick 的迷雾记忆（顶层变量，每局 Worker 独立）

function decide(observation) {
  try {
    return run(observation);
  } catch (e) {
    return { moves: [], memory: null };
  }
}

function newState(o, N) {
  return {
    seed: o.seed, N: N, last: -1,
    ownM: new Int16Array(N).fill(-2),
    armM: new Int32Array(N).fill(-1),
    seen: new Int32Array(N).fill(-1)
  };
}

function run(o) {
  var W = o.width, H = o.height, N = W * H, me = o.you.id, myTeam = o.you.team, t = o.tick;
  if (!S || S.seed !== o.seed || S.N !== N || t < S.last) S = newState(o, N);
  S.last = t;

  var team = [], alive = [];
  for (var pi = 0; pi < o.players.length; pi++) {
    var p = o.players[pi];
    team[p.id] = p.team; alive[p.id] = p.alive;
  }
  var tr = new Int8Array(N), ow = new Int16Array(N), ar = new Int32Array(N);
  for (var y = 0; y < H; y++) {
    var tro = o.terrain[y], oo = o.owner[y], ao = o.army[y];
    for (var x = 0; x < W; x++) {
      var i = y * W + x;
      tr[i] = tro[x];
      var w = oo[x];
      if (w !== -2) { S.ownM[i] = w; S.armM[i] = ao[x]; S.seen[i] = t; }
      w = S.ownM[i];
      if (w >= 0 && !alive[w]) w = -1;
      ow[i] = w; ar[i] = S.armM[i];
    }
  }

  var g = 1 + Math.floor(t / 200);
  var gi = o.you.general.y * W + o.you.general.x;
  var friend = function (w) { return w >= 0 && team[w] === myTeam; };
  var enemy = function (w) { return w >= 0 && team[w] !== myTeam; };
  var moves = [];
  var mission = 'none';
  var out = function () { return { moves: moves, memory: { v: 1, seed: o.seed, m: mission } }; };

  // 本地模拟一次移动；拒绝必败进攻，避免白送兵力
  var mv = function (i, d, half) {
    if (moves.length >= 4 || ow[i] !== me || ar[i] < 2) return -1;
    var nx = i % W + DX[d], ny = ((i / W) | 0) + DY[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return -1;
    var j = ny * W + nx;
    if (tr[j] === 1 || tr[j] === -1 || ar[j] < 0) return -1;
    var a = ar[i], k = half ? (a >> 1) : a - 1;
    if (k < 1) return -1;
    if (friend(ow[j])) { ar[j] += k; }
    else {
      if (k <= ar[j]) return -1;
      ow[j] = me; ar[j] = k - ar[j];
    }
    ar[i] = a - k;
    moves.push({ from: { x: i % W, y: (i / W) | 0 }, dir: DN[d], half: !!half });
    return j;
  };

  var bfs = function (srcs, ok) {
    var d = new Int32Array(N).fill(-1), q = new Int32Array(N), h = 0, e = 0;
    for (var s = 0; s < srcs.length; s++) { if (d[srcs[s]] < 0) { d[srcs[s]] = 0; q[e++] = srcs[s]; } }
    while (h < e) {
      var c = q[h++], cx = c % W, nd = d[c] + 1, j;
      if (cx > 0) { j = c - 1; if (d[j] < 0 && ok(j)) { d[j] = nd; q[e++] = j; } }
      if (cx < W - 1) { j = c + 1; if (d[j] < 0 && ok(j)) { d[j] = nd; q[e++] = j; } }
      if (c >= W) { j = c - W; if (d[j] < 0 && ok(j)) { d[j] = nd; q[e++] = j; } }
      if (c < N - W) { j = c + W; if (d[j] < 0 && ok(j)) { d[j] = nd; q[e++] = j; } }
    }
    return d;
  };
  var passAll = function (j) { return tr[j] !== 1; };
  var friendPass = function (j) { return tr[j] !== 1 && friend(ow[j]); };

  // 沿距离场下降方向选一步（只选能赢或己方的格子）
  var step = function (i, f, k) {
    if (f[i] <= 0) return -1;
    var x = i % W, y = (i / W) | 0, bd = -1, bs = 1e9;
    for (var d = 0; d < 4; d++) {
      var nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var j = ny * W + nx;
      if (tr[j] === 1 || tr[j] === -1 || f[j] < 0 || f[j] >= f[i]) continue;
      var fr = friend(ow[j]);
      if (!fr && ar[j] >= k) continue;
      var sc = f[j] * 2 + (fr ? 1 : 0);
      if (sc < bs) { bs = sc; bd = d; }
    }
    return bd;
  };

  var fscore = function (j) {
    var x = j % W, yy = (j / W) | 0, s = 0;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var nx = x + dx, ny = yy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var q = ny * W + nx;
      if (tr[q] === -1) s += 3; else if (tr[q] === 0 && ow[q] === -1) s += 1;
    }
    return s;
  };

  // 已知敌方将军（地形 3 会被永久记住）
  var gens = [];
  for (i = 0; i < N; i++) if (tr[i] === 3 && i !== gi && !friend(ow[i])) gens.push(i);

  // ---- A. 机会性攻占（斩首优先），不做必败进攻 ----
  var caps = [];
  for (i = 0; i < N; i++) {
    if (ow[i] !== me || ar[i] < 2) continue;
    var cx = i % W, cy = (i / W) | 0;
    for (var d = 0; d < 4; d++) {
      var nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var j = ny * W + nx;
      if (tr[j] === 1 || tr[j] === -1 || friend(ow[j]) || ar[j] < 0) continue;
      if (ar[i] - 1 <= ar[j]) continue;
      var v;
      if (tr[j] === 3) v = 1e6;
      else if (tr[j] === 2) v = (ow[j] === -1 ? 300 : 200 + ar[j]);
      else if (ow[j] === -1) continue; // 空地扩张由 C 步处理
      else v = 20 + ar[j];
      caps.push({ v: v, i: i, d: d });
    }
  }
  caps.sort(function (a, b) { return b.v - a.v || a.i - b.i || a.d - b.d; });
  var used = 0;
  for (var ci = 0; ci < caps.length; ci++) {
    var c = caps[ci];
    if (c.v >= 1e6 || used < 2) { if (mv(c.i, c.d, false) >= 0) used++; }
  }

  // ---- 重新统计己方格子与主力 ----
  var own = [], mainI = -1, mainA = 1;
  for (i = 0; i < N; i++) if (ow[i] === me) { own.push(i); if (ar[i] > mainA) { mainA = ar[i]; mainI = i; } }
  if (mainI < 0) return out();

  // ---- 威胁检测（将军附近可见的强敌）----
  var dG = bfs([gi], passAll);
  var thr = -1, thrA = 2;
  for (i = 0; i < N; i++) {
    if (enemy(ow[i]) && S.seen[i] === t && ar[i] > thrA && dG[i] >= 0 && dG[i] <= 7 && ar[i] * 1.5 >= ar[gi]) {
      thrA = ar[i]; thr = i;
    }
  }

  // ---- 选择主力任务 ----
  var dM = bfs([mainI], passAll);
  var k0 = mainA - 1;
  var fM = null;
  if (thr >= 0) {
    if (k0 > ar[thr] && dM[thr] >= 0 && dM[thr] <= 14) { mission = 'defend'; fM = bfs([thr], passAll); }
    else mission = 'guard';
  }
  if (mission === 'none' && gens.length) {
    var bi = -1, bd = 1e9;
    for (var gk = 0; gk < gens.length; gk++) {
      var gI = gens[gk];
      if (dM[gI] < 0) continue;
      var est = ar[gI] < 0 ? 40 : ar[gI];
      if (S.seen[gI] < t) est += Math.min(0.7 * g * (t - S.seen[gI]), 250);
      var need = est * 1.25 + 6 + 0.3 * dM[gI];
      if (k0 >= need && dM[gI] < bd) { bd = dM[gI]; bi = gI; }
    }
    if (bi >= 0) { mission = 'attack'; fM = bfs([bi], passAll); }
  }
  if (mission === 'none') {
    var bc = -1, bcd = 1e9;
    for (i = 0; i < N; i++) {
      if (tr[i] !== 2 || ow[i] !== -1 || dM[i] < 0 || dM[i] > 70) continue;
      var gr = ar[i] < 0 ? 50 : ar[i];
      if (k0 >= gr + 3 && dM[i] < bcd) { bcd = dM[i]; bc = i; }
    }
    if (bc >= 0) { mission = 'city'; fM = bfs([bc], passAll); }
  }
  if (mission === 'none') {
    var rs = [];
    for (i = 0; i < N; i++) if (enemy(ow[i]) && ar[i] >= 0 && ar[i] < k0 - 1) rs.push(i);
    if (rs.length) {
      var fr2 = bfs(rs, passAll);
      if (fr2[mainI] > 0 && fr2[mainI] <= 14) { mission = 'raid'; fM = fr2; }
    }
  }
  if (mission === 'none') {
    var ex = [];
    for (i = 0; i < N; i++) if (tr[i] === -1 || (tr[i] === 0 && ow[i] === -1)) ex.push(i);
    var fE = ex.length ? bfs(ex, passAll) : null;
    if (fE && fE[mainI] > 0 && (!gens.length || fE[mainI] <= 8)) { mission = 'expand'; fM = fE; }
    else mission = 'hold';
  }

  // ---- B. 主力移动 ----
  if (fM && mission !== 'guard' && mission !== 'hold') {
    var dd = step(mainI, fM, ar[mainI] - 1);
    if (dd >= 0) { var jj = mv(mainI, dd, false); if (jj >= 0) mainI = jj; }
  }

  // ---- C. 小股部队就近扩张（最多 2 步）----
  var cands = [];
  for (var oi = 0; oi < own.length; oi++) {
    var s0 = own[oi], a0 = ar[s0];
    if (ow[s0] !== me || a0 < 2 || a0 > 12 || s0 === mainI) continue;
    var sx = s0 % W, sy = (s0 / W) | 0, bdir = -1, bsc = -1;
    for (var d2 = 0; d2 < 4; d2++) {
      var tx = sx + DX[d2], ty = sy + DY[d2];
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      var tj = ty * W + tx;
      if (tr[tj] !== 0 || ow[tj] !== -1 || ar[tj] !== 0) continue;
      var sc = fscore(tj);
      if (sc > bsc) { bsc = sc; bdir = d2; }
    }
    if (bdir >= 0) cands.push({ s: bsc, i: s0, d: bdir });
  }
  cands.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
  var done = 0;
  for (var cj = 0; cj < cands.length; cj++) {
    if (moves.length >= 4 || done >= 2) break;
    var cc = cands[cj];
    if (mv(cc.i, cc.d, ar[cc.i] <= 6 ? false : true) >= 0) done++;
  }

  // ---- D. 其余大股部队向集结点汇聚（只走己方领土）----
  if (moves.length < 4) {
    var gT = (mission === 'guard') ? gi : mainI;
    var dGa = bfs([gT], friendPass);
    var gc = [];
    for (var gi2 = 0; gi2 < own.length; gi2++) {
      var s1 = own[gi2];
      if (ow[s1] !== me || ar[s1] < 2 || s1 === gT || s1 === mainI && mission !== 'guard') continue;
      if (dGa[s1] <= 0) continue;
      gc.push(s1);
    }
    gc.sort(function (a, b) { return ar[b] - ar[a] || a - b; });
    for (var gk2 = 0; gk2 < gc.length && moves.length < 4; gk2++) {
      var dir = step(gc[gk2], dGa, ar[gc[gk2]] - 1);
      if (dir >= 0) mv(gc[gk2], dir, false);
    }
  }
  return out();
}