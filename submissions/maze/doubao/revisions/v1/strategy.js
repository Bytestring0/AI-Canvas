const DIRS = [
  { action: 'up', dx: 0, dy: -1 },
  { action: 'right', dx: 1, dy: 0 },
  { action: 'down', dx: 0, dy: 1 },
  { action: 'left', dx: -1, dy: 0 }
];

function decide(o) {
  const mem = o.memory || {
    path: null,
    pathIndex: 0,
    targetKey: null
  };

  function posKey(x, y) {
    return `${x},${y}`;
  }

  function isInBounds(x, y) {
    return x >= 0 && x < o.width && y >= 0 && y < o.height && o.grid[y][x] === 0;
  }

  function getGate(x, y) {
    for (let i = 0; i < o.gates.length; i++) {
      const g = o.gates[i];
      if (g.x === x && g.y === y) return g;
    }
    return null;
  }

  function isGateClosed(gate, tick) {
    return (tick + gate.phase) % gate.period < gate.on;
  }

  function getTrap(x, y) {
    for (let i = 0; i < o.traps.length; i++) {
      const t = o.traps[i];
      if (t.x === x && t.y === y) return t;
    }
    return null;
  }

  function isTrapActive(trap, tick) {
    return (tick + trap.phase) % trap.period < trap.on;
  }

  function canEnter(x, y, tick) {
    if (!isInBounds(x, y)) return false;
    const gate = getGate(x, y);
    if (gate && isGateClosed(gate, tick)) return false;
    const trap = getTrap(x, y);
    if (trap && isTrapActive(trap, tick)) return false;
    return true;
  }

  function bfs(startX, startY, endX, endY, startTick) {
    const visited = new Set();
    const queue = [];
    let head = 0;

    queue.push({ x: startX, y: startY, steps: 0, path: [] });
    visited.add(`${startX},${startY},0`);

    while (head < queue.length) {
      const curr = queue[head++];

      if (curr.x === endX && curr.y === endY) {
        return curr.path;
      }

      if (curr.steps > o.maxTicks - startTick) continue;

      const actionTick = startTick + curr.steps;

      for (let i = 0; i < DIRS.length; i++) {
        const dir = DIRS[i];
        const nx = curr.x + dir.dx;
        const ny = curr.y + dir.dy;

        if (!canEnter(nx, ny, actionTick)) continue;

        const nextSteps = curr.steps + 1;
        const key = `${nx},${ny},${nextSteps}`;
        if (visited.has(key)) continue;

        visited.add(key);
        queue.push({
          x: nx,
          y: ny,
          steps: nextSteps,
          path: curr.path.concat({ action: dir.action, x: nx, y: ny })
        });
      }

      const waitSteps = curr.steps + 1;
      const waitKey = `${curr.x},${curr.y},${waitSteps}`;
      if (!visited.has(waitKey)) {
        visited.add(waitKey);
        queue.push({
          x: curr.x,
          y: curr.y,
          steps: waitSteps,
          path: curr.path.concat({ action: 'wait', x: curr.x, y: curr.y })
        });
      }
    }

    return null;
  }

  const mainTarget = o.key || o.exit;
  const targetKey = posKey(mainTarget.x, mainTarget.y);

  let needReplan = false;
  if (!mem.path || mem.pathIndex >= mem.path.length) {
    needReplan = true;
  } else if (mem.targetKey !== targetKey) {
    needReplan = true;
  } else {
    const nextStep = mem.path[mem.pathIndex];
    if (!canEnter(nextStep.x, nextStep.y, o.tick + mem.pathIndex)) {
      needReplan = true;
    }
    for (let i = 0; i < o.hunters.length; i++) {
      const h = o.hunters[i];
      const dist = Math.abs(h.x - o.player.x) + Math.abs(h.y - o.player.y);
      if (dist <= 4) {
        needReplan = true;
        break;
      }
    }
  }

  if (needReplan) {
    let bestPath = bfs(o.player.x, o.player.y, mainTarget.x, mainTarget.y, o.tick);

    if (bestPath && o.coins.length > 0) {
      const baseLen = bestPath.length;
      let bestExtra = 5;
      let bestCoinPath = null;

      for (let i = 0; i < o.coins.length; i++) {
        const coin = o.coins[i];
        const path1 = bfs(o.player.x, o.player.y, coin.x, coin.y, o.tick);
        if (!path1) continue;
        const path2 = bfs(coin.x, coin.y, mainTarget.x, mainTarget.y, o.tick + path1.length);
        if (!path2) continue;

        const totalLen = path1.length + path2.length;
        const extra = totalLen - baseLen;
        if (extra < bestExtra) {
          bestExtra = extra;
          bestCoinPath = path1.concat(path2);
        }
      }

      if (bestCoinPath) {
        bestPath = bestCoinPath;
      }
    }

    mem.path = bestPath;
    mem.pathIndex = 0;
    mem.targetKey = targetKey;
  }

  let action = 'wait';
  if (mem.path && mem.pathIndex < mem.path.length) {
    const step = mem.path[mem.pathIndex];
    if (canEnter(step.x, step.y, o.tick + mem.pathIndex)) {
      action = step.action;
      mem.pathIndex++;
    } else {
      mem.path = null;
    }
  }

  return {
    action: action,
    memory: mem
  };
}
