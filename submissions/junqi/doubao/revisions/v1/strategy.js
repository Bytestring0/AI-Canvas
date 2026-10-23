const DIR_MAP = {
  up: { dx: 0, dy: -1 },
  right: { dx: 1, dy: 0 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 }
};
const DIR_KEYS = ['up', 'right', 'down', 'left'];

function inBounds(x, y, width, height) {
  return x >= 0 && x < width && y >= 0 && y < height;
}

function bfs(startX, startY, terrain, width, height) {
  const dist = Array.from({ length: height }, () => Array(width).fill(Infinity));
  const queue = [[startX, startY]];
  dist[startY][startX] = 0;
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    for (const dir of DIR_KEYS) {
      const { dx, dy } = DIR_MAP[dir];
      const nx = x + dx;
      const ny = y + dy;
      if (inBounds(nx, ny, width, height) && terrain[ny][nx] !== 1 && dist[ny][nx] === Infinity) {
        dist[ny][nx] = dist[y][x] + 1;
        queue.push([nx, ny]);
      }
    }
  }
  return dist;
}

function computeTargetDistanceField(memory, terrain, width, height) {
  const dist = Array.from({ length: height }, () => Array(width).fill(Infinity));
  
  for (const city of memory.neutralCities) {
    const cityDist = bfs(city.x, city.y, terrain, width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (cityDist[y][x] < dist[y][x]) {
          dist[y][x] = cityDist[y][x];
        }
      }
    }
  }

  for (const gen of memory.enemyGenerals) {
    const genDist = bfs(gen.x, gen.y, terrain, width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (genDist[y][x] < dist[y][x]) {
          dist[y][x] = genDist[y][x];
        }
      }
    }
  }

  for (const city of memory.enemyCities) {
    const cityDist = bfs(city.x, city.y, terrain, width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (cityDist[y][x] < dist[y][x]) {
          dist[y][x] = cityDist[y][x];
        }
      }
    }
  }

  return dist;
}

function simulateMove(fromX, fromY, dir, half, simArmy, simOwner, myId, width, height) {
  const dirInfo = DIR_MAP[dir];
  if (!dirInfo) return;
  const nx = fromX + dirInfo.dx;
  const ny = fromY + dirInfo.dy;
  if (!inBounds(nx, ny, width, height)) return;

  const fromArmy = simArmy[fromY][fromX];
  const k = half ? Math.floor(fromArmy / 2) : fromArmy - 1;
  if (k < 1) return;

  simArmy[fromY][fromX] = fromArmy - k;

  const targetOwner = simOwner[ny][nx];
  const targetArmy = simArmy[ny][nx];

  if (targetOwner === myId) {
    simArmy[ny][nx] += k;
  } else {
    if (k > targetArmy) {
      simOwner[ny][nx] = myId;
      simArmy[ny][nx] = k - targetArmy;
    } else {
      simArmy[ny][nx] = targetArmy - k;
    }
  }
}

function calculateMoveValue(
  fromX, fromY, dir, half,
  simArmy, simOwner, terrain,
  myId, width, height,
  tick, maxTicks,
  targetDistField, unknownNeighbors,
  underThreat, generalDistField
) {
  const dirInfo = DIR_MAP[dir];
  if (!dirInfo) return -Infinity;
  const nx = fromX + dirInfo.dx;
  const ny = fromY + dirInfo.dy;

  if (!inBounds(nx, ny, width, height)) return -Infinity;
  if (terrain[ny][nx] === 1) return -Infinity;
  if (terrain[ny][nx] === -1) return -Infinity;

  const fromArmy = simArmy[fromY][fromX];
  if (fromArmy < 2) return -Infinity;

  const k = half ? Math.floor(fromArmy / 2) : fromArmy - 1;
  if (k < 1) return -Infinity;

  const targetOwner = simOwner[ny][nx];
  const targetArmy = simArmy[ny][nx];
  const g = 1 + Math.floor(tick / 200);
  const remainingTicks = maxTicks - tick;

  if (targetOwner === myId) {
    let value = 0;
    const targetDist = targetDistField[ny][nx];
    if (targetDist !== Infinity) {
      value += 15 / (targetDist + 1);
    }

    if (underThreat) {
      const gDist = generalDistField[ny][nx];
      if (gDist !== Infinity) {
        value += 35 / (gDist + 1);
      }
    }

    value += unknownNeighbors[ny][nx] * 0.3;
    return value;
  }

  if (k <= targetArmy) {
    return -k * 1.2;
  }

  const loss = targetArmy;
  let assetGain = 0;

  if (terrain[ny][nx] === 3) {
    return 100000;
  } else if (terrain[ny][nx] === 2) {
    assetGain += remainingTicks * g * 2.2;
    assetGain += 60;
  } else {
    const cycles = Math.floor(remainingTicks / 25);
    assetGain += cycles * g * 0.6;
    assetGain += unknownNeighbors[ny][nx] * 1.1;
  }

  if (targetOwner >= 0 && targetOwner !== myId) {
    assetGain *= 1.8;
    assetGain += targetArmy * 0.4;
  }

  return assetGain - loss * 1.0;
}

function decide(observation) {
  const {
    tick,
    maxTicks,
    width,
    height,
    you,
    terrain,
    owner,
    army,
    memory: memIn
  } = observation;
  const myId = you.id;

  let memory = memIn;
  if (!memory) {
    memory = {
      neutralCities: [],
      enemyGenerals: [],
      enemyCities: []
    };
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (terrain[y][x] === -1) continue;
      if (terrain[y][x] === 2) {
        if (owner[y][x] === -1 && army[y][x] !== -1) {
          const exists = memory.neutralCities.some(c => c.x === x && c.y === y);
          if (!exists) {
            memory.neutralCities.push({ x, y, army: army[y][x] });
          }
        } else if (owner[y][x] >= 0 && owner[y][x] !== myId) {
          const exists = memory.enemyCities.some(c => c.x === x && c.y === y);
          if (!exists) {
            memory.enemyCities.push({ x, y });
          }
        }
      } else if (terrain[y][x] === 3) {
        if (owner[y][x] >= 0 && owner[y][x] !== myId) {
          const exists = memory.enemyGenerals.some(g => g.x === x && g.y === y);
          if (!exists) {
            memory.enemyGenerals.push({ x, y });
          }
        }
      }
    }
  }

  memory.neutralCities = memory.neutralCities.filter(c => owner[c.y][c.x] !== myId);
  memory.enemyGenerals = memory.enemyGenerals.filter(g => terrain[g.y][g.x] === 3);
  memory.enemyCities = memory.enemyCities.filter(c => terrain[c.y][c.x] === 2 && owner[c.y][c.x] !== myId);

  const unknownNeighbors = Array.from({ length: height }, () => Array(width).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (inBounds(nx, ny, width, height) && terrain[ny][nx] === -1) {
            count++;
          }
        }
      }
      unknownNeighbors[y][x] = count;
    }
  }

  const targetDistField = computeTargetDistanceField(memory, terrain, width, height);
  const generalDistField = bfs(you.general.x, you.general.y, terrain, width, height);

  let underThreat = false;
  let minEnemyDist = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (owner[y][x] >= 0 && owner[y][x] !== myId && army[y][x] > 0) {
        const d = generalDistField[y][x];
        if (d < minEnemyDist) minEnemyDist = d;
      }
    }
  }
  if (minEnemyDist < 6) underThreat = true;

  const simArmy = army.map(row => [...row]);
  const simOwner = owner.map(row => [...row]);
  const moves = [];

  for (let step = 0; step < 4; step++) {
    let bestMove = null;
    let bestValue = -Infinity;
    let bestHalf = true;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (simOwner[y][x] !== myId) continue;
        if (simArmy[y][x] < 2) continue;

        for (const dir of DIR_KEYS) {
          for (const half of [true, false]) {
            const val = calculateMoveValue(
              x, y, dir, half,
              simArmy, simOwner, terrain,
              myId, width, height,
              tick, maxTicks,
              targetDistField, unknownNeighbors,
              underThreat, generalDistField
            );
            if (val > bestValue) {
              bestValue = val;
              bestMove = { from: { x, y }, dir, half };
              bestHalf = half;
            }
          }
        }
      }
    }

    if (!bestMove || bestValue <= 0) break;

    simulateMove(
      bestMove.from.x, bestMove.from.y,
      bestMove.dir, bestHalf,
      simArmy, simOwner,
      myId, width, height
    );
    moves.push(bestMove);
  }

  return { moves, memory };
}
