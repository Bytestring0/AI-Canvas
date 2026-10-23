// The deliberately weak built-in baseline: every tick it moves half of the armies
// from its strongest known tile in a rotating direction. No pathfinding, no target
// selection, no city cost awareness, no defence — it does not even look for generals.
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

// Baselines are demonstrations, never attributed to an AI model.
export const BASELINE = {
  id: 'demo-baseline',
  name: '基准机器人',
  kind: 'baseline',
  color: '#8a9a5b',
  source: `${decide.toString()}\n`,
  note: '很弱很弱的基准：每 tick 从军队最多的己方格子出发，按上右下左固定轮转方向移动一半军队。不认路、不打城市、不找将军、不防守，也不记忆地形。',
  readme: '内置基准机器人，不是外部 AI 作品。它只做一件事：把最强格子的半军按固定方向轮转推进，用来验证接口和作为最弱参照。',
};
