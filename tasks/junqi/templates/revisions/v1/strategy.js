function decide(o) {
  const dirs = [['up', 0, -1], ['right', 1, 0], ['down', 0, 1], ['left', -1, 0]];
  const state = o.memory && Number.isInteger(o.memory.turn) ? o.memory : {turn: 0};
  let best = null, bestArmy = 1;
  for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) {
    if (o.owner[y][x] !== o.you.id) continue;
    const army = o.army[y][x];
    if (army > bestArmy) {bestArmy = army; best = {x, y}}
  }
  if (best) {
    for (let i = 0; i < 4; i++) {
      const turn = (state.turn + i) % 4;
      const [dir, dx, dy] = dirs[turn];
      const terrain = o.terrain[best.y + dy]?.[best.x + dx];
      if (terrain === 0 || terrain === 2 || terrain === 3) {
        return {moves: [{from: best, dir, half: true}], memory: {turn: (turn + 1) % 4}};
      }
    }
  }
  return {moves: [], memory: {turn: (state.turn + 1) % 4}};
}
