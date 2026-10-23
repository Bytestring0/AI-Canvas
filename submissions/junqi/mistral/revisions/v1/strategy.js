// strategy.js
const DIRS = [
  { name: 'up', dx: 0, dy: -1 },
  { name: 'right', dx: 1, dy: 0 },
  { name: 'down', dx: 0, dy: 1 },
  { name: 'left', dx: -1, dy: 0 }
];
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

function decide(o) {
  let memory = o.memory;
  const myId = o.you.id;
  const tick = o.tick;
  const width = o.width;
  const height = o.height;

  if (memory === null) {
    memory = {
      myId,
      generalPos: { x: o.you.general.x, y: o.you.general.y },
      enemyGenerals: {},
      neutralCities: [],
      myCities: [],
      lastTick: -1
    };
  }

  const visible = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (o.owner[y][x] !== -2) {
        visible.push({ x, y, terrain: o.terrain[y][x], owner: o.owner[y][x], army: o.army[y][x] });
      }
    }
  }

  updateMemory(o, memory, visible, tick);

  if (!o.you.alive) {
    return { moves: [], memory };
  }

  const myCells = [];
  for (const cell of visible) {
    if (cell.owner === myId && cell.army > 0) {
      myCells.push({ x: cell.x, y: cell.y, army: cell.army });
    }
  }
  myCells.sort((a, b) => b.army - a.army);

  const threats = checkThreats(o, memory, visible);
  if (threats.length > 0) {
    const moves = handleDefense(o, memory, myCells, threats);
    memory.lastTick = tick;
    return { moves: moves.slice(0, 4), memory };
  }

  const targets = findTargets(o, memory, visible, myCells);
  const moves = [];
  const usedFrom = new Set();

  for (const target of targets) {
    if (moves.length >= 4) break;
    let bestSource = null;
    let bestScore = -Infinity;
    for (const cell of myCells) {
      if (usedFrom.has(`${cell.x},${cell.y}`)) continue;
      if (cell.army < 2) continue;
      const dist = manhattan(cell, target);
      if (dist === 0) continue;
      let score = cell.army / (dist + 1);
      if (target.type === 'enemy_general') score *= 3;
      else if (target.type === 'neutral_city') score *= 2;
      else if (target.type === 'enemy_city') score *= 1.5;
      if (score > bestScore) {
        bestScore = score;
        bestSource = cell;
      }
    }
    if (!bestSource) continue;
    const dir = findBestDir(o, bestSource, target);
    if (!dir) continue;
    const dist = manhattan(bestSource, target);
    let half = true;
    if (dist <= 1) half = false;
    else if (target.army && bestSource.army - 1 > target.army) half = false;
    else if (dist <= 2 && (target.type === 'enemy_general' || target.type === 'neutral_city')) half = false;
    moves.push({ from: { x: bestSource.x, y: bestSource.y }, dir, half });
    usedFrom.add(`${bestSource.x},${bestSource.y}`);
  }

  if (moves.length === 0 && myCells.length > 0) {
    for (const cell of myCells) {
      if (cell.army < 2) continue;
      const dir = findRandomDir(o, cell, memory);
      if (dir) {
        moves.push({ from: { x: cell.x, y: cell.y }, dir, half: true });
        break;
      }
    }
  }

  memory.lastTick = tick;
  return { moves: moves.slice(0, 4), memory };
}

function updateMemory(o, memory, visible, tick) {
  const myId = memory.myId;
  for (const cell of visible) {
    if (cell.terrain === 3 && cell.owner === myId) {
      memory.generalPos = { x: cell.x, y: cell.y };
      break;
    }
  }
  for (const cell of visible) {
    if (cell.terrain === 3 && cell.owner !== myId && cell.owner >= 0) {
      memory.enemyGenerals[cell.owner] = { x: cell.x, y: cell.y, lastSeen: tick, army: cell.army };
    }
  }
  memory.neutralCities = [];
  for (const cell of visible) {
    if (cell.terrain === 2 && cell.owner === -1) {
      memory.neutralCities.push({ x: cell.x, y: cell.y, army: cell.army });
    }
  }
  memory.myCities = [];
  for (const cell of visible) {
    if (cell.terrain === 2 && cell.owner === myId) {
      memory.myCities.push({ x: cell.x, y: cell.y });
    }
  }
  return memory;
}

function checkThreats(o, memory, visible) {
  const threats = [];
  const myId = memory.myId;
  const gx = memory.generalPos.x;
  const gy = memory.generalPos.y;
  for (const dir of DIRS) {
    const nx = gx + dir.dx;
    const ny = gy + dir.dy;
    if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
    for (const cell of visible) {
      if (cell.x === nx && cell.y === ny && cell.owner !== myId && cell.owner >= 0) {
        threats.push({ x: nx, y: ny, enemyId: cell.owner, army: cell.army, direction: dir.name });
        break;
      }
    }
  }
  return threats;
}

function handleDefense(o, memory, myCells, threats) {
  const moves = [];
  const myId = memory.myId;
  const gx = memory.generalPos.x;
  const gy = memory.generalPos.y;
  for (const threat of threats) {
    for (const dir of DIRS) {
      const nx = gx + dir.dx;
      const ny = gy + dir.dy;
      if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
      for (const cell of myCells) {
        if (cell.x === nx && cell.y === ny && cell.army >= 2) {
          moves.push({ from: { x: nx, y: ny }, dir: OPPOSITE[dir.name], half: false });
          if (moves.length >= 4) return moves;
          break;
        }
      }
    }
    for (const cell of myCells) {
      if (cell.army < 2) continue;
      const dist = manhattan(cell, memory.generalPos);
      if (dist === 0) continue;
      const dir = findBestDir(o, cell, memory.generalPos);
      if (dir) {
        moves.push({ from: { x: cell.x, y: cell.y }, dir, half: false });
        if (moves.length >= 4) return moves;
        break;
      }
    }
  }
  return moves;
}

function findTargets(o, memory, visible, myCells) {
  const targets = [];
  const myId = memory.myId;
  const tick = o.tick;
  for (const [enemyId, info] of Object.entries(memory.enemyGenerals)) {
    targets.push({
      type: 'enemy_general',
      x: info.x,
      y: info.y,
      enemyId: parseInt(enemyId),
      value: 10000,
      army: info.army + (tick - info.lastSeen),
      distance: manhattan({ x: info.x, y: info.y }, memory.generalPos)
    });
  }
  for (const city of memory.neutralCities) {
    targets.push({
      type: 'neutral_city',
      x: city.x,
      y: city.y,
      value: 5000 + city.army * 5,
      army: city.army,
      distance: manhattan(city, memory.generalPos)
    });
  }
  for (const cell of visible) {
    if (cell.terrain === 2 && cell.owner !== myId && cell.owner >= 0) {
      targets.push({
        type: 'enemy_city',
        x: cell.x,
        y: cell.y,
        value: 3000,
        enemyId: cell.owner,
        army: cell.army,
        distance: manhattan(cell, memory.generalPos)
      });
    }
  }
  for (const cell of myCells) {
    for (const dir of DIRS) {
      const nx = cell.x + dir.dx;
      const ny = cell.y + dir.dy;
      if (nx < 0 || nx >= o.width || ny < 0 || ny >= o.height) continue;
      if (!visible.some(v => v.x === nx && v.y === ny)) {
        targets.push({
          type: 'frontier',
          x: nx,
          y: ny,
          value: 1000,
          distance: manhattan({ x: nx, y: ny }, memory.generalPos)
        });
        break;
      }
    }
  }
  targets.sort((a, b) => {
    const scoreA = a.value / (a.distance + 1);
    const scoreB = b.value / (b.distance + 1);
    return scoreB - scoreA;
  });
  return targets;
}

function findBestDir(o, from, target) {
  const width = o.width;
  const height = o.height;
  let bestDir = null;
  let bestImprovement = -Infinity;
  for (const dir of DIRS) {
    const nx = from.x + dir.dx;
    const ny = from.y + dir.dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    if (o.terrain[ny][nx] === 1) continue;
    const oldDist = manhattan(from, target);
    const newDist = manhattan({ x: nx, y: ny }, target);
    const improvement = oldDist - newDist;
    if (improvement > bestImprovement) {
      bestImprovement = improvement;
      bestDir = dir.name;
    }
  }
  return bestDir;
}

function findRandomDir(o, cell, memory) {
  const validDirs = [];
  for (const dir of DIRS) {
    const nx = cell.x + dir.dx;
    const ny = cell.y + dir.dy;
    if (nx >= 0 && nx < o.width && ny >= 0 && ny < o.height && o.terrain[ny][nx] !== 1) {
      validDirs.push(dir.name);
    }
  }
  if (validDirs.length === 0) return null;
  const seed = o.seed + o.tick + cell.x + cell.y;
  const idx = Math.abs(hashCode(seed)) % validDirs.length;
  return validDirs[idx];
}