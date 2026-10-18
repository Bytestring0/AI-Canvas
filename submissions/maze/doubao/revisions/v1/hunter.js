const HUNTER_DIRS = [
  { action: 'up', dx: 0, dy: -1 },
  { action: 'right', dx: 1, dy: 0 },
  { action: 'down', dx: 0, dy: 1 },
  { action: 'left', dx: -1, dy: 0 }
];

function decide(o) {
  const mem = o.memory || {
    lastPlayerX: -1,
    lastPlayerY: -1
  };

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

  function canEnter(x, y, tick) {
    if (!isInBounds(x, y)) return false;
    const gate = getGate(x, y);
    if (gate && isGateClosed(gate, tick)) return false;
    return true;
  }

  function bfs(startX, startY, endX, endY, startTick, stepInterval) {
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

      if (curr.steps >= 10) continue;

      const actionTick = startTick + curr.steps * stepInterval;

      for (let i = 0; i < HUNTER_DIRS.length; i++) {
        const dir = HUNTER_DIRS[i];
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
          path: curr.path.concat(dir.action)
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
          path: curr.path.concat('wait')
        });
      }
    }

    return null;
  }

  const playerTarget = o.key || o.exit;
  const actions = [];

  for (let i = 0; i < o.hunters.length; i++) {
    const hunter = o.hunters[i];
    let targetX, targetY;

    switch (hunter.id) {
      case 0:
        targetX = o.player.x;
        targetY = o.player.y;
        break;
      case 1:
        targetX = playerTarget.x;
        targetY = playerTarget.y;
        break;
      case 2:
        if (mem.lastPlayerX >= 0) {
          const dx = o.player.x - mem.lastPlayerX;
          const dy = o.player.y - mem.lastPlayerY;
          targetX = o.player.x + dx * 3;
          targetY = o.player.y + dy * 3;
          targetX = Math.max(1, Math.min(o.width - 2, targetX));
          targetY = Math.max(1, Math.min(o.height - 2, targetY));
        } else {
          targetX = o.player.x;
          targetY = o.player.y;
        }
        break;
      default:
        targetX = o.player.x;
        targetY = o.player.y;
    }

    const path = bfs(hunter.x, hunter.y, targetX, targetY, o.tick, o.hunterEvery);
    let action = 'wait';
    if (path && path.length > 0) {
      action = path[0];
    }

    actions.push({ id: hunter.id, action: action });
  }

  mem.lastPlayerX = o.player.x;
  mem.lastPlayerY = o.player.y;

  return {
    actions: actions,
    memory: mem
  };
}
