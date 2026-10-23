// strategy.js — 将军棋策略（junqi-2）
// 设计：确定性、常数级内存、每 tick 只做 O(W·H) 扫描。
// 核心思路：
//  1. 记忆已知地形、已见敌方将军位置、上次发现的敌方领土，避免重复探索。
//  2. 优先保护己方将军：若敌军靠近则在将军周围集结守军。
//  3. 扩张：用己方高军力格子向相邻的空地/城市（军力低于自身）推进，
//     城市只在有明显兵力优势时才攻打。
//  4. 攻将军：若已知敌将军位置，派遣最大军团沿 BFS 路径进攻。
//  5. 搜将军：未见敌将军时，向地图中心与未侦察区域的加权方向推进。
//  6. 使用 half 移动保留守军，并用确定性伪随机打破平局。

const DIRS = [
  ['up', 0, -1],
  ['right', 1, 0],
  ['down', 0, 1],
  ['left', -1, 0],
];

// 确定性 PRNG（mulberry32），由种子字符串与 tick 派生
function makeRng(seedStr, tick) {
  let h = 2166136261 >>> 0;
  const s = String(seedStr) + '|' + String(tick);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 顶层记忆：跨 tick 保留（同时写入 memory 以便重放一致）
let mem = null;

function initMemory(o) {
  return {
    knownEnemyGenerals: [], // [{x,y,owner}]
    lastSeenArmy: null,
    lastTick: -1,
    targetGeneral: null,
    searchIdx: 0,
  };
}

function inBounds(o, x, y) {
  return x >= 0 && y >= 0 && x < o.width && y < o.height;
}

function isFriendly(o, owner) {
  if (owner === o.you.id) return true;
  // 同队判断：通过 players 数组查找队伍
  for (const p of o.players) {
    if (p.id === owner) return p.team === o.you.team && p.id !== o.you.id ? true : false;
  }
  return false;
}

function isEnemyOwner(o, owner) {
  if (owner < 0) return false; // 中立或未知
  if (owner === o.you.id) return false;
  return !isFriendly(o, owner);
}

// 多源 BFS：从给定起点集合出发，计算到所有可通行格子的距离
// 可通行 = 地形非山地且非未知（已侦察或视野内可见）
function bfsDistances(o, sources) {
  const W = o.width, H = o.height;
  const dist = new Int32Array(W * H).fill(-1);
  const queue = [];
  for (const s of sources) {
    const idx = s.y * W + s.x;
    if (dist[idx] === -1) {
      dist[idx] = 0;
      queue.push(idx);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % W, cy = (cur - cx) / W;
    for (const [, dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(o, nx, ny)) continue;
      const nidx = ny * W + nx;
      if (dist[nidx] !== -1) continue;
      const t = o.terrain[ny][nx];
      if (t === 1) continue; // 山地不可通行
      dist[nidx] = dist[cur] + 1;
      queue.push(nidx);
    }
  }
  return dist;
}

function dirTo(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (dx === 0 && dy === -1) return 'up';
  if (dx === 1 && dy === 0) return 'right';
  if (dx === 0 && dy === 1) return 'down';
  if (dx === -1 && dy === 0) return 'left';
  return null;
}

// 从 from 出发，沿 dist（指向目标的距离场）选择下一步最优邻居
function stepToward(o, from, distField) {
  const W = o.width;
  const curD = distField[from.y * W + from.x];
  if (curD <= 0) return null;
  let best = null, bestD = Infinity;
  for (const [dir, dx, dy] of DIRS) {
    const nx = from.x + dx, ny = from.y + dy;
    if (!inBounds(o, nx, ny)) continue;
    const d = distField[ny * W + nx];
    if (d === -1) continue;
    if (d < bestD) {
      bestD = d;
      best = { x: nx, y: ny, dir };
    }
  }
  return best;
}

function decide(o) {
  if (!mem || mem.lastTick > o.tick) mem = initMemory(o);
  if (!o.you.alive) return { moves: [], memory: mem };
  mem.lastTick = o.tick;

  const W = o.width, H = o.height;
  const rng = makeRng(o.seed, o.tick);
  const moves = [];

  // ---- 1. 扫描当前视野：收集己方格子、可见敌方格子、敌方将军 ----
  const myCells = [];
  const enemyGenerals = [];
  const enemyCells = [];
  let myGeneral = o.you.general;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ow = o.owner[y][x];
      const t = o.terrain[y][x];
      if (ow === o.you.id) myCells.push({ x, y, army: o.army[y][x] });
      if (t === 3 && ow !== o.you.id && ow >= 0 && isEnemyOwner(o, ow)) {
        enemyGenerals.push({ x, y, owner: ow });
      }
      if (ow >= 0 && isEnemyOwner(o, ow)) enemyCells.push({ x, y, owner: ow, army: o.army[y][x] });
    }
  }

  // 记住已见敌方将军位置（迷雾下仍保留）
  for (const g of enemyGenerals) {
    const exists = mem.knownEnemyGenerals.some(k => k.x === g.x && k.y === g.y);
    if (!exists) mem.knownEnemyGenerals.push(g);
  }
  // 若敌将军已被击杀（其格子不再是将军地形/归属变化），清理
  mem.knownEnemyGenerals = mem.knownEnemyGenerals.filter(g => {
    const t = o.terrain[g.y][g.x];
    return t === 3 || t === 2; // 将军被攻陷后变为城市，仍视为有效目标需重新验证
  }).filter(g => o.terrain[g.y][g.x] === 3);

  // 选择攻击目标：最近的已知敌将军
  let target = null;
  if (mem.knownEnemyGenerals.length > 0) {
    const srcs = myCells.map(c => ({ x: c.x, y: c.y }));
    if (srcs.length > 0) {
      const distFromTargets = bfsDistances(o, mem.knownEnemyGenerals.map(g => ({ x: g.x, y: g.y })));
      let bestD = Infinity;
      for (const c of myCells) {
        const d = distFromTargets[c.y * W + c.x];
        if (d >= 0 && d < bestD) bestD = d;
      }
      target = { field: distFromTargets, dist: bestD };
    }
  }

  // ---- 2. 防守判断：敌军是否接近己方将军 ----
  let threatNearGeneral = false;
  for (const e of enemyCells) {
    if (Math.abs(e.x - myGeneral.x) + Math.abs(e.y - myGeneral.y) <= 4 && e.army > 3) {
      threatNearGeneral = true;
      break;
    }
  }

  // ---- 3. 生成移动：按军力从大到小排序，最多 4 条 ----
  myCells.sort((a, b) => b.army - a.army || a.y - b.y || a.x - b.x);

  // 预计算搜将军距离场（未见敌将军时）：指向未侦察、远离己方将军的区域
  let searchField = null;
  if (!target && myCells.length > 0) {
    const unknownSources = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (o.terrain[y][x] === -1) unknownSources.push({ x, y });
      }
    }
    if (unknownSources.length > 0) {
      searchField = bfsDistances(o, unknownSources);
    }
  }

  const usedFrom = new Set();
  for (const c of myCells) {
    if (moves.length >= 4) break;
    if (c.army < 2) continue;
    const key = c.x + ',' + c.y;
    if (usedFrom.has(key)) continue;

    // 防守：若将军受威胁，留守近将军的格子（不向外发兵）
    const distToGeneral = Math.abs(c.x - myGeneral.x) + Math.abs(c.y - myGeneral.y);
    if (threatNearGeneral && distToGeneral > 0 && distToGeneral <= 3 && c.army < 6) {
      continue;
    }

    let chosen = null;

    // (a) 有已知敌将军：沿 BFS 路径进攻
    if (target && target.field) {
      const step = stepToward(o, c, target.field);
      if (step) {
        const tgt = o.terrain[step.y][step.x];
        const tgtOwner = o.owner[step.y][step.x];
        const isTargetGeneral = o.terrain[step.y][step.x] === 3;
        if (isTargetGeneral || tgtOwner !== o.you.id) {
          chosen = { dir: step.dir, half: true };
        } else {
          chosen = { dir: step.dir, half: true };
        }
      }
    }

    // (b) 没有目标：优先攻击相邻、且兵力明显更弱的敌/中立格；否则扩张到空地
    if (!chosen) {
      let bestScore = -Infinity, bestDir = null;
      for (const [dir, dx, dy] of DIRS) {
        const nx = c.x + dx, ny = c.y + dy;
        if (!inBounds(o, nx, ny)) continue;
        const t = o.terrain[ny][nx];
        if (t === 1 || t === -1) continue; // 山地或未知（未知暂不进入）
        const ow = o.owner[ny][nx];
        if (ow === o.you.id) continue;
        const tArmy = o.army[ny][nx]; // 视野外为 -1，视为未知
        let score;
        if (tArmy === -1) {
          score = 1; // 未知守军，轻微偏好
        } else {
          const need = Math.floor(c.army / 2); // 进攻力
          if (need > tArmy) {
            score = 10 + (t === 2 ? 2 : 0) + (t === 3 ? 100 : 0) - tArmy * 0.1;
          } else {
            score = -Infinity;
          }
        }
        // 空地优先（扩张），城市次之
        if (ow === -1 && t === 0) score += 3;
        if (t === 2) score += 1;
        score += rng() * 0.01; // 确定性平局打破
        if (score > bestScore) {
          bestScore = score;
          bestDir = dir;
        }
      }
      if (bestDir !== null && bestScore > -Infinity) {
        chosen = { dir: bestDir, half: true };
      }
    }

    // (c) 无攻击机会：向搜索场（未侦察区域）移动
    if (!chosen && searchField) {
      const step = stepToward(o, c, searchField);
      if (step) {
        const t = o.terrain[step.y][step.x];
        if (t !== 1) chosen = { dir: step.dir, half: true };
      }
    }

    if (chosen) {
      moves.push({ from: { x: c.x, y: c.y }, dir: chosen.dir, half: chosen.half });
      usedFrom.add(key);
    }
  }

  return { moves, memory: mem };
}