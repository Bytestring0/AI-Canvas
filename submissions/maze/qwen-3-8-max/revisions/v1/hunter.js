// hunter.js
function decide(observation) {
  const { grid, player, hunters, gates, tick, width, height } = observation;
  
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
  
  // Helper: Manhattan distance
  function manhattan(x1, y1, x2, y2) {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2);
  }
  
  // BFS to find shortest path to target
  function findShortestPath(startX, startY, targetX, targetY, startTick) {
    if (startX === targetX && startY === targetY) return [];
    
    const queue = [{ x: startX, y: startY, t: startTick, path: [] }];
    const visited = new Set([`${startX},${startY}`]);
    
    const moves = [
      { dx: 0, dy: -1, action: 'up' },
      { dx: 1, dy: 0, action: 'right' },
      { dx: 0, dy: 1, action: 'down' },
      { dx: -1, dy: 0, action: 'left' }
    ];
    
    let iterations = 0;
    const maxIterations = 1500;
    
    while (queue.length > 0 && iterations < maxIterations) {
      iterations++;
      const curr = queue.shift();
      
      for (const move of moves) {
        const nx = curr.x + move.dx;
        const ny = curr.y + move.dy;
        const nt = curr.t + 1;
        
        if (nx === targetX && ny === targetY && isPassable(nx, ny, nt)) {
          return [...curr.path, move.action];
        }
        
        if (isPassable(nx, ny, nt) && !visited.has(`${nx},${ny}`)) {
          visited.add(`${nx},${ny}`);
          queue.push({ x: nx, y: ny, t: nt, path: [...curr.path, move.action] });
        }
      }
    }
    
    return null;
  }
  
  // Predict player movement (simple: toward key or exit)
  function predictPlayerPosition() {
    const target = player.hasKey ? observation.exit : observation.key;
    if (!target) return { x: player.x, y: player.y };
    
    const path = findShortestPath(player.x, player.y, target.x, target.y, tick);
    if (path && path.length > 0) {
      const move = path[0];
      const moves = {
        'up': { dx: 0, dy: -1 },
        'down': { dx: 0, dy: 1 },
        'left': { dx: -1, dy: 0 },
        'right': { dx: 1, dy: 0 }
      };
      const { dx, dy } = moves[move];
      return { x: player.x + dx, y: player.y + dy };
    }
    return { x: player.x, y: player.y };
  }
  
  const actions = [];
  const predictedPlayer = predictPlayerPosition();
  
  // Strategy for each hunter
  for (const hunter of hunters) {
    let bestAction = 'wait';
    let bestScore = -Infinity;
    
    const moves = [
      { dx: 0, dy: -1, action: 'up' },
      { dx: 1, dy: 0, action: 'right' },
      { dx: 0, dy: 1, action: 'down' },
      { dx: -1, dy: 0, action: 'left' },
      { dx: 0, dy: 0, action: 'wait' }
    ];
    
    for (const move of moves) {
      const nx = hunter.x + move.dx;
      const ny = hunter.y + move.dy;
      
      if (!isPassable(nx, ny, tick + 1) && move.action !== 'wait') continue;
      
      // Calculate score based on distance to predicted player position
      const distToPlayer = manhattan(nx, ny, predictedPlayer.x, predictedPlayer.y);
      const distToCurrentPlayer = manhattan(nx, ny, player.x, player.y);
      
      // Prefer positions closer to both current and predicted player
      let score = 1000 - (distToPlayer * 10 + distToCurrentPlayer * 5);
      
      // Bonus for getting closer
      const currentDist = manhattan(hunter.x, hunter.y, player.x, player.y);
      if (distToCurrentPlayer < currentDist) {
        score += 100;
      }
      
      // Coordination: avoid clustering with other hunters
      for (const otherHunter of hunters) {
        if (otherHunter.id !== hunter.id) {
          const hunterDist = manhattan(nx, ny, otherHunter.x, otherHunter.y);
          if (hunterDist < 2) {
            score -= 50; // Penalty for being too close
          }
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestAction = move.action;
      }
    }
    
    // If direct approach doesn't work, try pathfinding
    if (bestAction === 'wait') {
      const path = findShortestPath(hunter.x, hunter.y, player.x, player.y, tick);
      if (path && path.length > 0) {
        bestAction = path[0];
      }
    }
    
    actions.push({ id: hunter.id, action: bestAction });
  }
  
  return { actions, memory: null };
}