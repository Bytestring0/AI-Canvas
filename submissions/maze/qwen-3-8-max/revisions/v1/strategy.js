// strategy.js
function decide(observation) {
  const { grid, player, key, exit, coins, gates, traps, hunters, tick, maxTicks, width, height } = observation;
  
  // Memory management
  let mem = observation.memory || {
    pathCache: null,
    targetPhase: 'toKey',
    lastDecision: 0
  };
  
  // Helper: Check if position is passable at tick t
  function isPassable(x, y, t) {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    if (grid[y][x] === 1) return false;
    for (const gate of gates) {
      if (gate.x === x && gate.y === y) {
        const isClosed = (t + gate.phase) % gate.period < gate.on;
        if (isClosed) return false;
      }
    }
    return true;
  }
  
  // Helper: Check if trap is safe at tick t
  function isTrapSafe(x, y, t) {
    for (const trap of traps) {
      if (trap.x === x && trap.y === y) {
        const isActive = (t + trap.phase) % trap.period < trap.on;
        if (isActive && t >= player.invulnerableUntil) return false;
      }
    }
    return true;
  }
  
  // Helper: Calculate hunter threat level
  function getHunterThreat(x, y, t) {
    let minDist = Infinity;
    for (const hunter of hunters) {
      const dist = Math.abs(x - hunter.x) + Math.abs(y - hunter.y);
      minDist = Math.min(minDist, dist);
    }
    return minDist;
  }
  
  // BFS with time dimension for pathfinding
  function findPath(startX, startY, targetX, targetY, startTick, maxSearchTicks = 100) {
    if (startX === targetX && startY === targetY) return [];
    
    const queue = [{ x: startX, y: startY, t: startTick, path: [], cost: 0 }];
    const visited = new Map();
    visited.set(`${startX},${startY},${startTick % 24}`, 0);
    
    const moves = [
      { dx: 0, dy: -1, action: 'up' },
      { dx: 1, dy: 0, action: 'right' },
      { dx: 0, dy: 1, action: 'down' },
      { dx: -1, dy: 0, action: 'left' }
    ];
    
    let iterations = 0;
    const maxIterations = 2000;
    
    while (queue.length > 0 && iterations < maxIterations) {
      iterations++;
      const curr = queue.shift();
      
      if (curr.t - startTick > maxSearchTicks) continue;
      
      for (const move of moves) {
        const nx = curr.x + move.dx;
        const ny = curr.y + move.dy;
        const nt = curr.t + 1;
        
        if (!isPassable(nx, ny, nt)) continue;
        
        if (nx === targetX && ny === targetY) {
          return [...curr.path, move.action];
        }
        
        const stateKey = `${nx},${ny},${nt % 24}`;
        const newCost = curr.cost + 1;
        
        if (!visited.has(stateKey) || visited.get(stateKey) > newCost) {
          visited.set(stateKey, newCost);
          queue.push({
            x: nx,
            y: ny,
            t: nt,
            path: [...curr.path, move.action],
            cost: newCost
          });
        }
      }
    }
    
    return null;
  }
  
  // Determine optimal target
  let target;
  if (player.hasKey) {
    target = exit;
    mem.targetPhase = 'toExit';
  } else if (key) {
    target = key;
    mem.targetPhase = 'toKey';
  } else {
    target = exit;
    mem.targetPhase = 'toExit';
  }
  
  // Try to find path to target
  let path = findPath(player.x, player.y, target.x, target.y, tick);
  
  // If path found, consider coin collection
  if (path && path.length > 0) {
    // Check if we should collect nearby coins
    if (!player.hasKey && coins.length > 0 && path.length < 50) {
      let bestCoinPath = null;
      let bestScore = -Infinity;
      
      // Check up to 3 closest coins
      const sortedCoins = coins.slice(0, 10).map(coin => {
        const dist = Math.abs(coin.x - player.x) + Math.abs(coin.y - player.y);
        return { coin, dist };
      }).sort((a, b) => a.dist - b.dist).slice(0, 3);
      
      for (const { coin, dist } of sortedCoins) {
        const coinPath = findPath(player.x, player.y, coin.x, coin.y, tick);
        if (coinPath && coinPath.length < 20) {
          // Check if path continues to target
          const continuePath = findPath(coin.x, coin.y, target.x, target.y, tick + coinPath.length);
          if (continuePath) {
            const totalLength = coinPath.length + continuePath.length;
            const score = (100 - totalLength) * 10 + (50 - dist);
            if (score > bestScore) {
              bestScore = score;
              bestCoinPath = coinPath;
            }
          }
        }
      }
      
      if (bestCoinPath && bestScore > 500) {
        path = bestCoinPath;
      }
    }
    
    // Check hunter threat on first move
    if (path.length > 0) {
      const move = path[0];
      const moves = {
        'up': { dx: 0, dy: -1 },
        'down': { dx: 0, dy: 1 },
        'left': { dx: -1, dy: 0 },
        'right': { dx: 1, dy: 0 }
      };
      
      const { dx, dy } = moves[move];
      const nx = player.x + dx;
      const ny = player.y + dy;
      
      // Check if this move is safe
      if (isTrapSafe(nx, ny, tick + 1)) {
        const threat = getHunterThreat(nx, ny, tick + 1);
        if (threat >= 2 || path.length <= 3) {
          return { action: move, memory: mem };
        }
      }
      
      // Try alternative if threat is high
      if (path.length > 1) {
        return { action: path[0], memory: mem };
      }
    }
  }
  
  // Fallback: wait or move safely
  const safeMoves = ['up', 'right', 'down', 'left'];
  for (const action of safeMoves) {
    const moves = {
      'up': { dx: 0, dy: -1 },
      'down': { dx: 0, dy: 1 },
      'left': { dx: -1, dy: 0 },
      'right': { dx: 1, dy: 0 }
    };
    const { dx, dy } = moves[action];
    const nx = player.x + dx;
    const ny = player.y + dy;
    
    if (isPassable(nx, ny, tick + 1) && isTrapSafe(nx, ny, tick + 1)) {
      return { action, memory: mem };
    }
  }
  
  return { action: 'wait', memory: mem };
}