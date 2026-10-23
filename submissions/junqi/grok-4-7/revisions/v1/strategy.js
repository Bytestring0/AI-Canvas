'use strict';

/**
 * junqi-2 / generals-like strategy.
 *
 * Each tick: remember what left vision, pick one objective, then issue up to
 * four downhill moves on a private copy of the map so later moves see earlier
 * ones. No randomness, clock, DOM, or network.
 */
function decide(observation) {
  try {
    return plan(observation);
  } catch (err) {
    if (typeof globalThis !== 'undefined' && globalThis.JUNQI_DEBUG) throw err;
    var prev = observation && observation.memory ? observation.memory : null;
    return { moves: [], memory: prev };
  }
}

var DIR_NAME = ['up', 'right', 'down', 'left'];
var DIR_X = [0, 1, 0, -1];
var DIR_Y = [-1, 0, 1, 0];

function plan(o) {
  if (!o || !o.you) return { moves: [], memory: null };
  if (o.you.alive === false) return { moves: [], memory: o.memory || null };

  var W = o.width | 0;
  var H = o.height | 0;
  if (W < 2 || H < 2 || W > 400 || H > 400) return { moves: [], memory: null };

  var N = W * H;
  var me = o.you.id | 0;
  var myTeam = o.you.team | 0;
  var tick = o.tick | 0;
  var pc = o.playerCount | 0;
  var maxTicks = o.maxTicks | 0;
  if (pc < 1) pc = 1;

  var teamOf = new Int16Array(Math.max(pc, 1));
  var aliveOf = new Uint8Array(Math.max(pc, 1));
  var myArmy = 0;
  var myLand = 0;
  var bestEnemyArmy = 0;
  var enemyArmySum = 0;
  var pi;
  var players = o.players || [];
  for (pi = 0; pi < players.length; pi++) {
    var p = players[pi];
    var pid = p.id | 0;
    if (pid >= 0 && pid < teamOf.length) {
      teamOf[pid] = p.team | 0;
      aliveOf[pid] = p.alive ? 1 : 0;
    }
    if (pid === me) {
      myArmy = p.army | 0;
      myLand = p.land | 0;
    } else if (p.alive && (p.team | 0) !== myTeam) {
      enemyArmySum += p.army | 0;
      if ((p.army | 0) > bestEnemyArmy) bestEnemyArmy = p.army | 0;
    }
  }

  function isAlly(id) {
    return id >= 0 && id < teamOf.length && id !== me && teamOf[id] === myTeam;
  }
  function isEnemy(id) {
    return id >= 0 && id < teamOf.length && id !== me && teamOf[id] !== myTeam;
  }
  function slotOf(id) {
    var start = ((tick % pc) + pc) % pc;
    return ((id - start) % pc + pc) % pc;
  }

  var gx = o.you.general.x | 0;
  var gy = o.you.general.y | 0;
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return { moves: [], memory: null };
  var genIdx = gy * W + gx;
  var mySlot = slotOf(me);

  var parsed = parseMem(o.memory);
  var cityMem = new Map();
  var genMem = new Map();
  var poiMem = new Map();
  ingest(parsed.c, W, H, cityMem);
  ingest(parsed.g, W, H, genMem);
  ingest(parsed.e, W, H, poiMem);

  var terr = new Int8Array(N);
  var baseOwner = new Int16Array(N);
  var baseArmy = new Int32Array(N);
  var simOwner = new Int16Array(N);
  var simArmy = new Int32Array(N);
  var spec = new Uint8Array(N);

  var y, x, i;
  for (y = 0; y < H; y++) {
    var rowT = o.terrain[y];
    var rowO = o.owner[y];
    var rowA = o.army[y];
    for (x = 0; x < W; x++) {
      i = y * W + x;
      terr[i] = rowT ? rowT[x] | 0 : 1;
      var ow0 = rowO ? rowO[x] | 0 : -2;
      var ar0 = rowA ? rowA[x] | 0 : -1;
      baseOwner[i] = ow0;
      baseArmy[i] = ar0;
      simOwner[i] = ow0;
      simArmy[i] = ar0;
    }
  }

  var ga = typeof parsed.ga === 'number' && isFinite(parsed.ga) ? parsed.ga | 0 : null;
  var gt = typeof parsed.gt === 'number' && isFinite(parsed.gt) ? parsed.gt | 0 : 0;
  if (baseOwner[genIdx] === me && baseArmy[genIdx] >= 0) {
    ga = baseArmy[genIdx];
    gt = tick;
  } else {
    var gEst = ga === null ? (1 + growthBetween(0, tick)) : (ga + growthBetween(gt, tick));
    if (gEst < 1) gEst = 1;
    simOwner[genIdx] = me;
    baseOwner[genIdx] = me;
    if (simArmy[genIdx] < 0) {
      simArmy[genIdx] = gEst;
      baseArmy[genIdx] = gEst;
    }
  }

  var owned = [];
  var inOwned = new Uint8Array(N);
  var cities = [];
  var generals = [];
  var visibleEnemy = [];
  var maxStack = 0;
  var movable = 0;
  var econ = 1;

  for (i = 0; i < N; i++) {
    var t = terr[i];
    var ow = simOwner[i];
    var ar = simArmy[i];
    if (ow !== -2 && ar >= 0) {
      if (t === 2) cityMem.set(i, [ow, ar, tick]);
      if (t === 3 && i !== genIdx) genMem.set(i, [ow, ar, tick]);
      if (isEnemy(ow) && (ar >= 3 || t === 2 || t === 3)) poiMem.set(i, [ow, ar, tick]);
      if (isEnemy(ow)) visibleEnemy.push(i);
    }
    if (ow === me && ar >= 0) {
      if (!inOwned[i]) {
        inOwned[i] = 1;
        owned.push(i);
      }
      if (ar > maxStack) maxStack = ar;
      if (ar >= 2) movable += ar - 1;
      if (t === 2) econ += 1;
    }
    if (t === 2) cities.push(i);
    else if (t === 3 && i !== genIdx) generals.push(i);
  }

  function estimateAt(iTile) {
    var sow = simOwner[iTile];
    var sar = simArmy[iTile];
    var ster = terr[iTile];
    if (sow !== -2 && sar >= 0) return { owner: sow, army: sar, known: 1 };
    var rec = null;
    if (ster === 3) rec = genMem.get(iTile) || null;
    else if (ster === 2) rec = cityMem.get(iTile) || null;
    else rec = poiMem.get(iTile) || null;
    if (rec) {
      var rowner = rec[0];
      var rarmy = rec[1];
      var rtick = rec[2];
      if (rowner >= 0 && rowner < aliveOf.length && !aliveOf[rowner] && rowner !== me) {
        return { owner: -2, army: rarmy > 0 ? rarmy : 1, known: 0 };
      }
      if (isAlly(rowner)) return { owner: rowner, army: rarmy > 0 ? rarmy : 1, known: 1 };
      if (rowner === -1) {
        if (ster === 2) return { owner: -1, army: rarmy, known: 1 };
        return { owner: -1, army: 0, known: 1 };
      }
      if (ster === 2 || ster === 3) {
        var grown = rarmy + growthBetween(rtick, tick);
        if (grown < 0) grown = 0;
        return { owner: rowner, army: grown, known: (tick - rtick <= 16) ? 1 : 0 };
      }
      return { owner: rowner, army: Math.max(0, rarmy + landGrowth(rtick, tick)), known: 0 };
    }
    if (ster === -1) return { owner: -1, army: 0, known: 0 };
    if (ster === 2) return { owner: -1, army: 50, known: 0 };
    if (ster === 3) return { owner: -2, army: 1000000, known: 0 };
    return { owner: -1, army: 0, known: 0 };
  }

  function passable(j, blockStrong, target) {
    if (j === target) return true;
    if (terr[j] === 1) return false;
    var bow = baseOwner[j];
    if (bow >= 0 && isAlly(bow)) return false;
    if (!blockStrong) return true;
    if (bow === me) return true;
    var ban = -1;
    if (bow !== -2 && baseArmy[j] >= 0 && isEnemy(bow)) ban = baseArmy[j];
    else if (terr[j] === 2 && bow !== me) ban = estimateAt(j).army;
    if (ban > 10 && ban > maxStack) return false;
    return true;
  }

  function bfs(seeds, blockStrong, target, onlyOwn, maxDepth, stopOwned) {
    var dist = new Int32Array(N);
    dist.fill(-1);
    var q = new Int32Array(N);
    var qh = 0;
    var qt = 0;
    var need = stopOwned ? owned.length : 0;
    var got = 0;
    var s;
    for (s = 0; s < seeds.length; s++) {
      var sj = seeds[s];
      if (sj < 0 || sj >= N || dist[sj] !== -1) continue;
      dist[sj] = 0;
      q[qt++] = sj;
      if (need && inOwned[sj]) got++;
    }
    while (qh < qt) {
      var cur = q[qh++];
      var baseD = dist[cur];
      if (maxDepth && baseD >= maxDepth) continue;
      var nd = baseD + 1;
      var cx = cur % W;
      var cy = (cur / W) | 0;
      var k;
      for (k = 0; k < 4; k++) {
        var nx = cx + DIR_X[k];
        var ny = cy + DIR_Y[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = ny * W + nx;
        if (dist[ni] !== -1) continue;
        if (onlyOwn && baseOwner[ni] !== me) continue;
        if (!passable(ni, blockStrong, target)) continue;
        dist[ni] = nd;
        q[qt++] = ni;
        if (need && inOwned[ni]) {
          got++;
          if (got >= need) return dist;
        }
      }
    }
    return dist;
  }

  function reachesUs(dist) {
    var u;
    for (u = 0; u < owned.length; u++) if (dist[owned[u]] >= 0) return true;
    return false;
  }

  function bfsTo(target, blockStrong) {
    var dist = bfs([target], blockStrong, target);
    if (!reachesUs(dist)) dist = bfs([target], false, target);
    return dist;
  }

  var fromUs = bfs(owned.length ? owned : [genIdx], false, -1);

  function nearest(idx) {
    return fromUs[idx];
  }

  var moves = [];

  function sendOf(n, minLeave) {
    if (n < 2) return null;
    if (minLeave <= 1) return { k: n - 1, half: false };
    var hk = n >> 1;
    if (hk >= 1 && (n - hk) >= minLeave) return { k: hk, half: true };
    return null;
  }

  function applyMove(from, dir, half) {
    var n = simArmy[from];
    if (simOwner[from] !== me || n < 2 || spec[from]) return false;
    var k = half ? (n >> 1) : (n - 1);
    if (k < 1) return false;
    var fx = from % W;
    var fy = (from / W) | 0;
    var tx = fx + DIR_X[dir];
    var ty = fy + DIR_Y[dir];
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    var ti = ty * W + tx;
    if (terr[ti] === 1) return false;
    var def = estimateAt(ti);
    if (isAlly(def.owner)) return false;
    simArmy[from] = n - k;
    if (terr[ti] === -1) {
      if (simOwner[ti] !== me) {
        simOwner[ti] = me;
        simArmy[ti] = k;
        if (!inOwned[ti]) {
          inOwned[ti] = 1;
          owned.push(ti);
        }
      } else {
        simArmy[ti] = (simArmy[ti] < 0 ? 0 : simArmy[ti]) + k;
      }
      spec[from] = 1;
      spec[ti] = 1;
      return true;
    }
    if (def.owner === me) {
      simArmy[ti] = def.army + k;
      return true;
    }
    if (k > def.army) {
      simArmy[ti] = k - def.army;
      simOwner[ti] = me;
      if (!inOwned[ti]) {
        inOwned[ti] = 1;
        owned.push(ti);
      }
      return true;
    }
    simArmy[ti] = def.army - k;
    if (simOwner[ti] === -2) simOwner[ti] = def.owner >= 0 ? def.owner : -1;
    return true;
  }

  function pushMove(from, dir, half) {
    if (moves.length >= 4) return false;
    if (!applyMove(from, dir, half)) return false;
    moves.push({
      from: { x: from % W, y: (from / W) | 0 },
      dir: DIR_NAME[dir],
      half: !!half
    });
    return true;
  }

  function attackersOf(target) {
    var list = [];
    var xx = target % W;
    var yy = (target / W) | 0;
    var k;
    for (k = 0; k < 4; k++) {
      var fx = xx - DIR_X[k];
      var fy = yy - DIR_Y[k];
      if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
      var fi = fy * W + fx;
      if (simOwner[fi] !== me || spec[fi]) continue;
      var n = simArmy[fi];
      var send = sendOf(n, fi === genIdx ? 1 : 1);
      if (!send) continue;
      list.push({ from: fi, dir: k, half: send.half, k: send.k });
    }
    list.sort(function (a, b) { return b.k - a.k || a.from - b.from; });
    return list;
  }

  function tryFinish(target) {
    if (target < 0 || moves.length >= 4) return false;
    if (simOwner[target] === me || isAlly(simOwner[target])) return false;
    var def = estimateAt(target);
    if (isAlly(def.owner) || def.owner === me) return false;
    var defArmy = def.army;
    if (defArmy >= 1000000) return false;
    var atks = attackersOf(target);
    var slots = 4 - moves.length;
    var chosen = [];
    var need = defArmy;
    var a;
    for (a = 0; a < atks.length && chosen.length < slots; a++) {
      chosen.push(atks[a]);
      need -= atks[a].k;
      if (need < 0) break;
    }
    if (need >= 0) return false;
    for (a = 0; a < chosen.length; a++) {
      pushMove(chosen[a].from, chosen[a].dir, chosen[a].half);
      if (simOwner[target] === me) return true;
    }
    return simOwner[target] === me;
  }

  // Threats first, using distance from the general (a stack can walk 4 tiles).
  var genDist = bfs([genIdx], false, genIdx, false, 6, false);
  var threats = [];
  var ei;
  for (ei = 0; ei < visibleEnemy.length; ei++) {
    var eIdx = visibleEnemy[ei];
    var ed = genDist[eIdx];
    if (ed < 0 || ed > 4) continue;
    var einf = estimateAt(eIdx);
    if (!isEnemy(einf.owner) || einf.army < 2) continue;
    threats.push({
      idx: eIdx,
      dist: ed,
      army: einf.army,
      owner: einf.owner,
      incoming: einf.army - ed,
      slot: slotOf(einf.owner)
    });
  }

  var ti;
  for (ti = 0; ti < threats.length && moves.length < 4; ti++) {
    var th = threats[ti];
    if (th.dist === 1 && th.slot > mySlot && th.incoming > simArmy[genIdx]) {
      tryFinish(th.idx);
    }
  }
  for (ei = 0; ei < generals.length && moves.length < 4; ei++) {
    var ginf = estimateAt(generals[ei]);
    if (!isEnemy(ginf.owner)) continue;
    if (nearest(generals[ei]) !== 1) continue;
    tryFinish(generals[ei]);
  }
  for (ei = 0; ei < cities.length && moves.length < 4; ei++) {
    var ctry = estimateAt(cities[ei]);
    if (ctry.owner === me || isAlly(ctry.owner)) continue;
    if (nearest(cities[ei]) !== 1) continue;
    if (ctry.army >= movable + maxStack && ctry.army >= maxStack) continue;
    tryFinish(cities[ei]);
  }

  // Recompute garrison constraint after pre-empts. Equal combat does not capture,
  // so leaving `incoming` (or adjacent army-1) is enough when we move first.
  var minLeave = 1;
  var needDefend = false;
  for (ti = 0; ti < threats.length; ti++) {
    th = threats[ti];
    if (simOwner[th.idx] === me) continue;
    var now = estimateAt(th.idx);
    if (!isEnemy(now.owner) || now.army < 2) continue;
    var incoming = now.army - th.dist;
    if (th.slot < mySlot) continue;
    if (th.dist === 1) {
      var worst = now.army - 1;
      if (worst > minLeave) minLeave = worst;
    }
    if (incoming > simArmy[genIdx]) needDefend = true;
  }
  if (minLeave > simArmy[genIdx]) minLeave = simArmy[genIdx] > 0 ? simArmy[genIdx] : 1;

  var genArmyNow = simArmy[genIdx] >= 0 ? simArmy[genIdx] : 1;

  function projected(dist) {
    var eta = dist > 0 ? Math.ceil(dist / 4) : 1;
    if (eta < 12) eta = 12;
    if (eta > 80) eta = 80;
    return movable + econ * growthBetween(tick, tick + eta);
  }

  var bestCity = -1;
  var bestCityScore = -1e15;
  var bestCityArmy = 0;
  var bestCityDist = -1;
  var ci;
  for (ci = 0; ci < cities.length; ci++) {
    i = cities[ci];
    var ce = estimateAt(i);
    if (ce.owner === me || isAlly(ce.owner)) continue;
    var cd = nearest(i);
    if (cd < 0) continue;
    var afford = maxStack > ce.army || projected(cd) >= ce.army;
    var score = -cd * 40 - ce.army * 5;
    if (isEnemy(ce.owner)) score += 260;
    if (maxStack > ce.army) score += 1000;
    else if (afford) score += 280;
    else score -= 8000;
    if (!ce.known) score -= 60;
    if (score > bestCityScore) {
      bestCityScore = score;
      bestCity = i;
      bestCityArmy = ce.army;
      bestCityDist = cd;
    }
  }

  var bestGen = -1;
  var bestGenScore = -1e15;
  var bestGenArmy = 0;
  var bestGenFresh = 0;
  var gi;
  for (gi = 0; gi < generals.length; gi++) {
    i = generals[gi];
    var ge = estimateAt(i);
    if (!isEnemy(ge.owner)) continue;
    var gd = nearest(i);
    if (gd < 0) continue;
    var grec = genMem.get(i);
    var seenTick = grec ? grec[2] : tick;
    var fresh = (simOwner[i] !== -2 && simArmy[i] >= 0) || (tick - seenTick <= 24);
    var affordG = maxStack > ge.army || (fresh && projected(gd) >= ge.army + 4 && myLand >= 6);
    var gscore = -gd * 22 - ge.army * 3 + 1800;
    if (maxStack > ge.army) gscore += 2500;
    if (!fresh) gscore -= 1600;
    if (!affordG) gscore -= 5000;
    if (tick > maxTicks * 0.55 && myArmy < bestEnemyArmy) gscore += 700;
    if (gscore > bestGenScore) {
      bestGenScore = gscore;
      bestGen = i;
      bestGenArmy = ge.army;
      bestGenFresh = fresh ? 1 : 0;
    }
  }

  var poiTarget = -1;
  var poiScore = -1;
  poiMem.forEach(function (rec, idx) {
    if (!isEnemy(rec[0])) return;
    if (tick - rec[2] > 200) return;
    var dd = genDist[idx];
    if (dd < 0) dd = nearest(idx);
    if (dd > poiScore) {
      poiScore = dd;
      poiTarget = idx;
    }
  });

  var focusMode = 0;
  var focusIdx = -1;
  if (parsed.f === 1 || parsed.f === 2) {
    var fxx = parsed.fx | 0;
    var fyy = parsed.fy | 0;
    if (fxx >= 0 && fyy >= 0 && fxx < W && fyy < H) {
      focusIdx = fyy * W + fxx;
      var fInf = estimateAt(focusIdx);
      var fOk = fInf.owner !== me && !isAlly(fInf.owner);
      var kindOk = (parsed.f === 1 && terr[focusIdx] === 2) ||
        (parsed.f === 2 && (terr[focusIdx] === 3 || isEnemy(fInf.owner)));
      var windowOk = tick <= (parsed.fu | 0);
      var hope = projected(Math.max(1, nearest(focusIdx))) + maxStack + 8 >= fInf.army || maxStack > fInf.army;
      if (fOk && kindOk && windowOk && hope) focusMode = parsed.f | 0;
      else focusIdx = -1;
    }
  }

  var mode = 'expand';
  var target = -1;
  var behind = tick > 80 && myArmy + 10 < bestEnemyArmy;
  var late = tick > maxTicks * 0.62;
  var ahead = enemyArmySum > 0 && myArmy > enemyArmySum * 1.12;

  if (needDefend) {
    mode = 'defend';
    target = genIdx;
  } else if (focusMode === 2 && !(ahead && late && maxStack <= bestGenArmy)) {
    mode = 'attack';
    target = focusIdx;
  } else if (focusMode === 1) {
    mode = 'city';
    target = focusIdx;
  } else if (bestGen >= 0 && (maxStack > bestGenArmy || (bestGenFresh && projected(nearest(bestGen)) >= bestGenArmy + 4 && myLand >= 6) || (behind && late && bestGenFresh))) {
    mode = 'attack';
    target = bestGen;
  } else if (bestCity >= 0 && (maxStack > bestCityArmy || projected(bestCityDist) >= bestCityArmy)) {
    mode = 'city';
    target = bestCity;
  } else if (poiTarget >= 0 && myLand >= 12 && tick > 70 && (behind || (late && !ahead)) && projected(8) > 30) {
    mode = 'attack';
    target = poiTarget;
  }

  if (needDefend) {
    mode = 'defend';
    target = genIdx;
  }

  var goalDist;
  if (mode === 'expand' || target < 0) {
    var seeds = [];
    var seeded = new Uint8Array(N);
    var oi;
    for (oi = 0; oi < owned.length; oi++) {
      var ocx = owned[oi] % W;
      var ocy = (owned[oi] / W) | 0;
      var ok;
      for (ok = 0; ok < 4; ok++) {
        var osx = ocx + DIR_X[ok];
        var osy = ocy + DIR_Y[ok];
        if (osx < 0 || osy < 0 || osx >= W || osy >= H) continue;
        var osi = osy * W + osx;
        if (seeded[osi]) continue;
        if (terr[osi] === 1 || terr[osi] === 2 || terr[osi] === 3) continue;
        var oow = baseOwner[osi];
        if (oow === me || isAlly(oow)) continue;
        if (terr[osi] === -1 || oow < 0 || (isEnemy(oow) && baseArmy[osi] === 0)) {
          seeded[osi] = 1;
          seeds.push(osi);
        }
      }
    }
    goalDist = seeds.length ? bfs(seeds, false, -1, true, 0, false) : bfs([genIdx], false, genIdx, true, 0, false);
    if (mode !== 'defend') mode = 'expand';
  } else {
    goalDist = bfsTo(target, true);
  }

  var aim = target;
  if (aim < 0 || mode === 'expand') {
    aim = -1;
    var aimBest = 1e9;
    for (ci = 0; ci < cities.length; ci++) {
      var ai = cities[ci];
      var ainf = estimateAt(ai);
      if (ainf.owner === me || isAlly(ainf.owner)) continue;
      if (ainf.army > maxStack && ainf.army > Math.max(70, projected(nearest(ai)))) continue;
      var ad = nearest(ai);
      if (ad >= 0 && ad < aimBest) {
        aimBest = ad;
        aim = ai;
      }
    }
    if (aim < 0 && bestGen >= 0 && (bestGenFresh || tick > maxTicks * 0.35)) aim = bestGen;
    if (aim < 0 && poiTarget >= 0 && tick > 40) aim = poiTarget;
    if (aim < 0) {
      // Centroid of unseen tiles. Skipping this and aiming at the geometric
      // center parks the whole army on the first city that happens to sit there.
      var sx = 0;
      var sy = 0;
      var scount = 0;
      var fi;
      for (fi = 0; fi < N; fi++) {
        if (terr[fi] !== -1) continue;
        sx += fi % W;
        sy += (fi / W) | 0;
        scount++;
      }
      if (scount > 0) {
        var mx = (sx / scount) | 0;
        var my = (sy / scount) | 0;
        var bestD = 1e15;
        for (fi = 0; fi < N; fi++) {
          if (terr[fi] === 1 || baseOwner[fi] === me || isAlly(baseOwner[fi])) continue;
          var dx = (fi % W) - mx;
          var dy = ((fi / W) | 0) - my;
          var dsq = dx * dx + dy * dy;
          if (dsq < bestD) {
            bestD = dsq;
            aim = fi;
          }
        }
      }
    }
  }
  var aimDist = aim >= 0 ? bfs([aim], false, aim, false, 0, true) : null;

  function leaveNeeded() {
    if (mode === 'defend') return genArmyNow > 0 ? Math.max(minLeave, genArmyNow) : 1;
    return minLeave;
  }

  function scoreMove(from, dir, half) {
    var n = simArmy[from];
    if (simOwner[from] !== me || n < 2 || spec[from]) return -1000000000;
    var k = half ? (n >> 1) : (n - 1);
    if (k < 1) return -1000000000;
    var leave = n - k;
    if (from === genIdx && leave < leaveNeeded()) return -1000000000;
    var fx = from % W;
    var fy = (from / W) | 0;
    var tx = fx + DIR_X[dir];
    var ty = fy + DIR_Y[dir];
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return -1000000000;
    var to = ty * W + tx;
    if (terr[to] === 1) return -1000000000;
    var def = estimateAt(to);
    if (isAlly(def.owner)) return -1000000000;

    var dFrom = goalDist[from];
    var dTo = goalDist[to];
    var toward = dFrom >= 0 && dTo >= 0 && dTo < dFrom;
    var aFrom = aimDist ? aimDist[from] : -1;
    var aTo = aimDist ? aimDist[to] : -1;
    var aimStep = (aFrom >= 0 && aTo >= 0) ? (aFrom - aTo) : 0;
    // Stacks (army >= 4) keep their mass on the objective. Army 2-3 grabs any land.
    var marching = n >= 4 && (mode === 'city' || mode === 'attack');
    var s = aimStep * (marching ? 900 : 200) - (to % 7);

    if (def.owner === me) {
      if (!toward && !(marching && aimStep > 0)) return -1000000000;
      if (mode === 'expand') s += (toward ? (dFrom - dTo) * 240 : 0) + Math.min(k, 50) * 4 + 30;
      else s += (toward ? (dFrom - dTo) * 560 : 0) + Math.min(k, 700) * 16 + 100;
      if (!half && mode !== 'expand') s += 70;
      if (mode === 'defend' && to === genIdx) s += 8000 + Math.min(k, 500) * 25;
      if (marching && aimStep > 0) s += 13000 + Math.min(k, 400) * 12;
      return s;
    }

    if (terr[to] === -1) {
      if (marching && aimStep > 0) return s + 14500 + Math.min(k, 120) * 8;
      if (aimStep > 0 || toward) {
        s += mode === 'expand' ? 4700 : 2600;
        if (k > 24) s -= (k - 24) * 15;
        return s;
      }
      return -1000000000;
    }

    if (k <= def.army) return -1000000000;

    s += 4800 + Math.min(def.army, 900) * 16;
    if (def.army === 0) {
      if (mode === 'expand') s += 5600;
      else if (toward || terr[to] === 2) s += 3000;
      else s -= 1800;
      if (!half) s += 240;
    } else if (!half) s += 160;
    if (terr[to] === 2) s += 16000;
    if (terr[to] === 3 && isEnemy(def.owner)) s += 2000000;
    if (isEnemy(def.owner)) s += 1100;
    if (toward) s += (dFrom - dTo) * 180 + 500;
    else if (mode !== 'expand' && terr[to] !== 2 && terr[to] !== 3) s -= 900;
    s += Math.min(k - def.army, 200);
    if (marching && terr[to] !== 2 && terr[to] !== 3) {
      if (aimStep > 0) s += 6000;
      else if (aimStep === 0) s -= 2500;
      else s -= 12000;
    }

    if (mode === 'expand' && def.army === 0 && !marching) {
      var open = 0;
      var kk;
      for (kk = 0; kk < 4; kk++) {
        var ax = tx + DIR_X[kk];
        var ay = ty + DIR_Y[kk];
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        var aj = ay * W + ax;
        if (terr[aj] === 1 || simOwner[aj] === me) continue;
        open++;
      }
      s += open * 110;
    }
    return s;
  }

  var round;
  for (round = 0; round < 4 && moves.length < 4; round++) {
    var bestS = 300;
    var bestFrom = -1;
    var bestDir = 0;
    var bestHalf = false;
    var ui;
    for (ui = 0; ui < owned.length; ui++) {
      var u = owned[ui];
      if (simOwner[u] !== me || simArmy[u] < 2 || spec[u]) continue;
      var dir;
      for (dir = 0; dir < 4; dir++) {
        var halfFlag;
        for (halfFlag = 0; halfFlag < 2; halfFlag++) {
          var sc = scoreMove(u, dir, halfFlag === 1);
          if (sc > bestS) {
            bestS = sc;
            bestFrom = u;
            bestDir = dir;
            bestHalf = halfFlag === 1;
          }
        }
      }
    }
    if (bestFrom < 0) break;
    if (!pushMove(bestFrom, bestDir, bestHalf)) break;
  }

  var outC = [];
  var outG = [];
  var outE = [];
  cityMem.forEach(function (rec, idx) {
    if (terr[idx] !== 2) return;
    outC.push(idx % W, (idx / W) | 0, rec[0] | 0, rec[1] | 0, rec[2] | 0);
  });
  genMem.forEach(function (rec, idx) {
    if (idx === genIdx || rec[0] === me) return;
    if (terr[idx] !== 3 && !(isEnemy(rec[0]) && tick - rec[2] < 30)) return;
    if (terr[idx] === 1) return;
    outG.push(idx % W, (idx / W) | 0, rec[0] | 0, rec[1] | 0, rec[2] | 0);
  });
  var poiArr = [];
  poiMem.forEach(function (rec, idx) {
    if (!isEnemy(rec[0])) return;
    if (tick - rec[2] > 160) return;
    poiArr.push(rec[1], rec[2], idx, rec[0]);
  });
  var packed = [];
  var pe;
  for (pe = 0; pe + 3 < poiArr.length; pe += 4) packed.push([poiArr[pe], poiArr[pe + 1], poiArr[pe + 2], poiArr[pe + 3]]);
  packed.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1] || a[2] - b[2]; });
  for (pe = 0; pe < packed.length && pe < 24; pe++) {
    outE.push(packed[pe][2] % W, (packed[pe][2] / W) | 0, packed[pe][3] | 0, packed[pe][0] | 0, packed[pe][1] | 0);
  }

  var memory = { v: 1, c: outC, g: outG, e: outE };
  if (ga !== null) {
    memory.ga = ga;
    memory.gt = gt;
  }
  if ((mode === 'city' || mode === 'attack') && target >= 0 && target !== genIdx) {
    memory.f = mode === 'city' ? 1 : 2;
    memory.fx = target % W;
    memory.fy = (target / W) | 0;
    memory.fu = tick + 80;
    if (parsed.f === memory.f && (parsed.fx | 0) === memory.fx && (parsed.fy | 0) === memory.fy) {
      memory.fu = parsed.fu | 0;
      if (memory.fu < tick) memory.fu = tick + 40;
    }
  }

  var serial = JSON.stringify(memory);
  if (serial.length > 26000) {
    memory.e = [];
    memory.c = outC.slice(0, 700);
    serial = JSON.stringify(memory);
  }
  if (serial.length > 30000) {
    memory.c = outC.slice(0, 250);
    memory.g = outG.slice(0, 40);
  }
  return { moves: moves, memory: memory };
}

function ingest(arr, W, H, map) {
  if (!arr) return;
  var i;
  for (i = 0; i + 4 < arr.length; i += 5) {
    var x = arr[i] | 0;
    var y = arr[i + 1] | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    map.set(y * W + x, [arr[i + 2] | 0, arr[i + 3] | 0, arr[i + 4] | 0]);
  }
}

function parseMem(m) {
  if (!m || typeof m !== 'object') return { c: [], g: [], e: [] };
  return {
    c: numList(m.c),
    g: numList(m.g),
    e: numList(m.e),
    f: m.f | 0,
    fx: m.fx | 0,
    fy: m.fy | 0,
    fu: m.fu | 0,
    ga: typeof m.ga === 'number' ? m.ga : null,
    gt: typeof m.gt === 'number' ? m.gt : 0
  };
}

function numList(a) {
  if (!Array.isArray(a)) return [];
  var out = [];
  var i;
  for (i = 0; i < a.length && out.length < 6000; i++) {
    var n = a[i];
    if (typeof n !== 'number' || !isFinite(n)) continue;
    out.push(n | 0);
  }
  var extra = out.length % 5;
  if (extra) out.length -= extra;
  return out;
}

function growthBetween(t0, t1) {
  if (t1 <= t0) return 0;
  var sum = 0;
  var t = t0 | 0;
  var endTick = t1 | 0;
  while (t < endTick) {
    var end = (((t / 200) | 0) + 1) * 200;
    if (end > endTick) end = endTick;
    sum += (end - t) * (1 + ((t / 200) | 0));
    t = end;
  }
  return sum;
}

function landGrowth(t0, t1) {
  if (t1 <= t0) return 0;
  var sum = 0;
  var t;
  for (t = t0 | 0; t < t1; t++) {
    if (((t + 1) % 25) === 0) sum += 1 + ((t / 200) | 0);
  }
  return sum;
}