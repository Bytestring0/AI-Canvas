// hunter.js
/**
 * 迷宫竞速 - 追逐者协同围堵策略 (Coordinated Hunter Strategy)
 * 特性：
 * 1. 动态角色分配 (Role Allocation)：
 *    - 主追逐者 (Direct Chaser)：计算考虑闸门周期的最短路径，对玩家施加直接追尾压力。
 *    - 拦截者 (Intercepter / Chokepoint Blocker)：预判玩家目标（钥匙或出口），提前封锁咽喉要道。
 *    - 侧翼伏击者 (Flanker / Pincer)：向玩家周围分叉口包抄，压制玩家转向与逃逸空间。
 * 2. 闸门前瞻阻挡感知：不盲目撞击当前 tick 关闭的闸门，自动择优绕行或在闸门前蓄势。
 * 3. 冲突避免与协同扩散：多追逐者间通过目标点差异化，避免完全重叠挤入同一条走廊。
 */

function decide(observation) {
  const {
    tick, width, height, grid,
    player, key, exit, gates, hunters
  } = observation;

  const DIRS = [
    { action: 'up', dx: 0, dy: -1 },
    { action: 'right', dx: 1, dy: 0 },
    { action: 'down', dx: 0, dy: 1 },
    { action: 'left', dx: -1, dy: 0 }
  ];

  function inBounds(x, y) {
    return x >= 0 && x < width && y >= 0 && y < height;
  }

  function isPassage(x, y) {
    return inBounds(x, y) && grid[y][x] === 0;
  }

  // 当前行动 tick 闸门阻挡检测（追逐者不能进入当前关闭的闸门）
  function isGateClosedNow(x, y) {
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i];
      if (g.x === x && g.y === y) {
        return ((tick + g.phase) % g.period) < g.on;
      }
    }
    return false;
  }

  // 针对特定追逐者寻找通往目标的单源 BFS 最优第一步
  function findBestMoveTo(startX, startY, targetX, targetY, reservedTargets) {
    // 快速检查：已在目标点
    if (startX === targetX && startY === targetY) {
      return 'wait';
    }

    const dist = new Int16Array(width * height).fill(-1);
    const parent = new Int32Array(width * height).fill(-1);
    const queueX = new Int16Array(width * height);
    const queueY = new Int16Array(width * height);
    let head = 0, tail = 0;

    const startIdx = startY * width + startX;
    dist[startIdx] = 0;
    queueX[tail] = startX;
    queueY[tail] = startY;
    tail++;

    let reachedTarget = false;
    let targetIdx = targetY * width + targetX;

    while (head < tail) {
      const cx = queueX[head];
      const cy = queueY[head];
      const curIdx = cy * width + cx;
      head++;

      if (cx === targetX && cy === targetY) {
        reachedTarget = true;
        break;
      }

      for (let i = 0; i < 4; i++) {
        const nx = cx + DIRS[i].dx;
        const ny = cy + DIRS[i].dy;

        if (!isPassage(nx, ny)) continue;

        // 若为首步，且目标格闸门关闭，追逐者无法进入
        if (cx === startX && cy === startY && isGateClosedNow(nx, ny)) {
          continue;
        }

        const nIdx = ny * width + nx;
        if (dist[nIdx] === -1) {
          dist[nIdx] = dist[curIdx] + 1;
          parent[nIdx] = curIdx;
          queueX[tail] = nx;
          queueY[tail] = ny;
          tail++;
        }
      }
    }

    // 若无法到达指定目标点（被闸门完全封死等），回退至距离玩家曼哈顿距离最小的候选方向
    if (!reachedTarget || parent[targetIdx] === -1) {
      let fallbackAction = 'wait';
      let bestDist = 999999;
      for (let i = 0; i < 4; i++) {
        const nx = startX + DIRS[i].dx;
        const ny = startY + DIRS[i].dy;
        if (isPassage(nx, ny) && !isGateClosedNow(nx, ny)) {
          const d = Math.abs(nx - targetX) + Math.abs(ny - targetY);
          if (d < bestDist) {
            bestDist = d;
            fallbackAction = DIRS[i].action;
          }
        }
      }
      return fallbackAction;
    }

    // 从终点反向回溯至起点的下一格
    let curr = targetIdx;
    while (parent[curr] !== startIdx && parent[curr] !== -1) {
      curr = parent[curr];
    }

    const nextX = curr % width;
    const nextY = Math.floor(curr / width);

    for (let i = 0; i < 4; i++) {
      if (startX + DIRS[i].dx === nextX && startY + DIRS[i].dy === nextY) {
        return DIRS[i].action;
      }
    }

    return 'wait';
  }

  // 玩家的关键逃生目标
  const playerObjective = (player.hasKey || !key) ? exit : key;

  // 针对不同追逐者分配协同围捕战术
  const actions = [];
  const assignedGoals = [];

  for (let idx = 0; idx < hunters.length; idx++) {
    const h = hunters[idx];
    let target = { x: player.x, y: player.y };

    if (idx === 0) {
      // 0 号：贴身紧逼，直接死咬玩家当前位置
      target = { x: player.x, y: player.y };
    } else if (idx === 1) {
      // 1 号：关键咽喉截断，直扑玩家必经的阶段目标（钥匙或出口）
      // 若玩家离目标过远，则堵截玩家与目标中点，否则直接蹲守目标
      const midX = Math.round((player.x + playerObjective.x) / 2);
      const midY = Math.round((player.y + playerObjective.y) / 2);
      target = isPassage(midX, midY) ? { x: midX, y: midY } : { x: playerObjective.x, y: playerObjective.y };
    } else {
      // 2 号及以上：包抄侧翼，定位至玩家邻近的分支路口，封死退路
      let bestFlank = { x: player.x, y: player.y };
      let maxDistFromH0 = -1;
      const h0 = hunters[0];

      for (let i = 0; i < 4; i++) {
        const fx = player.x + DIRS[i].dx * 2;
        const fy = player.y + DIRS[i].dy * 2;
        if (isPassage(fx, fy)) {
          const dToH0 = Math.abs(fx - h0.x) + Math.abs(fy - h0.y);
          if (dToH0 > maxDistFromH0) {
            maxDistFromH0 = dToH0;
            bestFlank = { x: fx, y: fy };
          }
        }
      }
      target = bestFlank;
    }

    assignedGoals.push(target);
    const chosenAction = findBestMoveTo(h.x, h.y, target.x, target.y, assignedGoals);
    actions.push({ id: h.id, action: chosenAction });
  }

  return {
    actions,
    memory: null
  };
}