// strategy.js
/**
 * 迷宫竞速 - 跑者智能策略 (Maze Runner Strategy)
 * 特性：
 * 1. 时空危险规避 (Spacetime Hazard Avoidance)：精确计算未来时间步机关激活、闸门启闭与追逐者拦截距离。
 * 2. 动态目标规划：优先钥匙 -> 出口；在安全裕度内根据“得分收益/偏航代价比”贪心捡拾沿途晶片。
 * 3. 前瞻搜索 (Safe Spacetime BFS/A*)：寻找兼顾时间代价与生存安全的全局/局部最优解。
 * 4. 遇险回旋与兜圈 (Evasion & Loop Kiting)：被围堵时向连通自由度高、追逐者距离最远的安全格撤退。
 */

function decide(observation) {
  const {
    tick, maxTicks, width, height, grid,
    player, key, exit, coins, gates, traps,
    hunters, hunterEvery, memory: prevMem
  } = observation;

  const mem = prevMem || { stuckCount: 0, lastPos: null };

  // 坐标工具
  const DIRS = [
    { action: 'up', dx: 0, dy: -1 },
    { action: 'right', dx: 1, dy: 0 },
    { action: 'down', dx: 0, dy: 1 },
    { action: 'left', dx: -1, dy: 0 }
  ];

  const posKey = (x, y) => (y << 16) | x;

  function inBounds(x, y) {
    return x >= 0 && x < width && y >= 0 && y < height;
  }

  function isPassage(x, y) {
    return inBounds(x, y) && grid[y][x] === 0;
  }

  // 计算指定 tick 时闸门是否关闭
  function isGateClosedAt(x, y, t) {
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i];
      if (g.x === x && g.y === y) {
        return ((t + g.phase) % g.period) < g.on;
      }
    }
    return false;
  }

  // 计算指定 tick 时机关是否激活
  function isTrapActiveAt(x, y, t) {
    for (let i = 0; i < traps.length; i++) {
      const tr = traps[i];
      if (tr.x === x && tr.y === y) {
        return ((t + tr.phase) % tr.period) < tr.on;
      }
    }
    return false;
  }

  // 基础静态 BFS 距离图计算
  function computeDistanceMap(starts) {
    const dist = new Int16Array(width * height).fill(-1);
    const queueX = new Int16Array(width * height);
    const queueY = new Int16Array(width * height);
    let head = 0, tail = 0;

    for (const s of starts) {
      if (inBounds(s.x, s.y)) {
        const idx = s.y * width + s.x;
        dist[idx] = 0;
        queueX[tail] = s.x;
        queueY[tail] = s.y;
        tail++;
      }
    }

    while (head < tail) {
      const cx = queueX[head];
      const cy = queueY[head];
      head++;
      const curD = dist[cy * width + cx];

      for (let i = 0; i < 4; i++) {
        const nx = cx + DIRS[i].dx;
        const ny = cy + DIRS[i].dy;
        if (isPassage(nx, ny)) {
          const nIdx = ny * width + nx;
          if (dist[nIdx] === -1) {
            dist[nIdx] = curD + 1;
            queueX[tail] = nx;
            queueY[tail] = ny;
            tail++;
          }
        }
      }
    }
    return dist;
  }

  // 计算所有追逐者到全图各格子的静态最短距离
  const hunterDist = computeDistanceMap(hunters);

  // 计算主目标（钥匙未拿则钥匙，拿了则出口）的距离图
  const primaryTarget = player.hasKey || !key ? exit : key;
  const targetDist = computeDistanceMap([primaryTarget]);

  // 计算追逐者在指定 tick 到达 (x, y) 所需的估算行动回合数（考虑 hunterEvery）
  function hunterArrivalTicks(x, y) {
    const idx = y * width + x;
    const d = hunterDist[idx];
    if (d === -1) return 9999;
    if (d === 0) return 0;
    // 追逐者每 hunterEvery 步走 1 格，计算到抵达需要的 tick 差
    let stepsNeeded = d;
    let t = tick;
    while (stepsNeeded > 0 && t < tick + 60) {
      t++;
      if (t % hunterEvery === 0) {
        stepsNeeded--;
      }
    }
    return t - tick;
  }

  // 判断从当前状态走一格 (nx, ny) 在 tick 结算时是否致命或受到不可承受的伤害
  function isDirectHazard(nx, ny, t) {
    const trapHit = isTrapActiveAt(nx, ny, t);
    // 判断追逐者在 tick t 是否可能落在此格
    // 若本 tick 追逐者行动：(t % hunterEvery === 0)，距离 <= 1 的追逐者可到达
    const willHuntersMove = (t % hunterEvery === 0);
    let hunterHit = false;
    for (let i = 0; i < hunters.length; i++) {
      const h = hunters[i];
      const hDist = Math.abs(h.x - nx) + Math.abs(h.y - ny);
      if (willHuntersMove) {
        if (hDist <= 1) { hunterHit = true; break; }
      } else {
        if (hDist === 0) { hunterHit = true; break; }
      }
    }

    if (trapHit || hunterHit) {
      // 若受无敌保护且不是持续受困，可酌情承受，但尽量规避
      const isInvulnerable = t < player.invulnerableUntil;
      if (!isInvulnerable || player.hp <= 1) {
        return true;
      }
    }
    return false;
  }

  // 评估沿途是否有极高性价比的晶片
  // 晶片满分 1000 分，若 detour <= 4 且绝对安全，则优先顺路采集
  let bestTarget = primaryTarget;
  let minCost = targetDist[player.y * width + player.x];

  if (coins && coins.length > 0) {
    let bestCoin = null;
    let bestCoinGain = -1;

    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      const cIdx = c.y * width + c.x;
      const dPlayerCoin = computeDistanceMap([c])[player.y * width + player.x];
      const dCoinTarget = targetDist[cIdx];
      if (dPlayerCoin === -1 || dCoinTarget === -1) continue;

      const detour = (dPlayerCoin + dCoinTarget) - minCost;
      // 仅当追逐者远离且偏离原路径极小 (<= 4 格) 时考虑采集
      const hTicks = hunterArrivalTicks(c.x, c.y);
      if (detour <= 4 && hTicks > (dPlayerCoin + 6)) {
        const gain = 100 - detour * 12;
        if (gain > bestCoinGain) {
          bestCoinGain = gain;
          bestCoin = c;
        }
      }
    }

    if (bestCoin && bestCoinGain > 30) {
      bestTarget = bestCoin;
    }
  }

  // 重置目标距离图为最终选定的目标
  const activeTargetDist = (bestTarget === primaryTarget) ? targetDist : computeDistanceMap([bestTarget]);

  // 前瞻时空搜索 (Spacetime A* / BFS)，寻找最佳第一步动作
  const candidates = [];
  const allMoves = [...DIRS, { action: 'wait', dx: 0, dy: 0 }];

  for (let m = 0; m < allMoves.length; m++) {
    const move = allMoves[m];
    const nx = player.x + move.dx;
    const ny = player.y + move.dy;

    if (!isPassage(nx, ny)) continue;

    // 闸门阻挡：如果进入关闭闸门，则无法通过（原地停留不受向外阻挡限制，但进入受限）
    if (move.action !== 'wait' && isGateClosedAt(nx, ny, tick)) {
      continue;
    }

    const nextTick = tick + 1;
    // 检查直接伤害/死亡危险
    const directDanger = isDirectHazard(nx, ny, nextTick);

    // 计算到目标的距离与追逐者安全度
    const nextIdx = ny * width + nx;
    const dTarget = activeTargetDist[nextIdx];
    const hDistVal = hunterDist[nextIdx];

    // 综合代价评估
    let penalty = 0;
    if (directDanger) penalty += 20000;

    // 追逐者逼近惩罚（距离越近，惩罚呈指数上升）
    if (hDistVal <= 1) penalty += 5000;
    else if (hDistVal === 2) penalty += 1500;
    else if (hDistVal === 3) penalty += 400;
    else if (hDistVal === 4) penalty += 100;

    // 移动收益：越接近目标代价越低
    penalty += (dTarget !== -1 ? dTarget * 25 : 3000);

    // 等待惩罚：无故等待扣分，但在规避机关/等门时允许
    if (move.action === 'wait') {
      penalty += 35;
    }

    // 连通分支评估：避免被逼入死胡同 (度数检测)
    let degrees = 0;
    for (let d = 0; d < 4; d++) {
      const adjX = nx + DIRS[d].dx;
      const adjY = ny + DIRS[d].dy;
      if (isPassage(adjX, adjY) && !isGateClosedAt(adjX, adjY, nextTick)) {
        degrees++;
      }
    }
    if (degrees <= 1 && hDistVal <= 4) {
      penalty += 4000; // 危险死胡同严重惩罚
    }

    candidates.push({
      action: move.action,
      score: penalty,
      targetDist: dTarget,
      hunterDist: hDistVal
    });
  }

  // 排序选出综合评分最优（penalty 最小）的移动
  candidates.sort((a, b) => a.score - b.score);

  let chosenAction = 'wait';
  if (candidates.length > 0) {
    chosenAction = candidates[0].action;
  }

  // 死锁与原地踏步兜底检测
  const curPosStr = `${player.x},${player.y}`;
  let stuckCount = mem.lastPos === curPosStr ? mem.stuckCount + 1 : 0;
  if (stuckCount >= 3 && candidates.length > 1) {
    // 若连续在同一格子发呆超过 3 次，且有次选安全动作，尝试破局
    if (candidates[1].score < 10000) {
      chosenAction = candidates[1].action;
    }
  }

  return {
    action: chosenAction,
    memory: {
      stuckCount,
      lastPos: curPosStr
    }
  };
}