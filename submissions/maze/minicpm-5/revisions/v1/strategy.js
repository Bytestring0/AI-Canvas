function decide(o) {
  const moves = ['up', 'right', 'down', 'left'];
  let turn = o.memory || 0;
  for (let i = 0; i < 4; i++) {
    const [action, dx, dy] = moves[(turn + i) % 4];
    const x = o.player.x + dx;
    const y = o.player.y + dy;
    if (o.grid[y][x] !== 1 && !o.gates.some(g => g.x === x && g.y === y && o.gates[g].closed)) {
      return { action, memory: turn + i };
    }
  }
  return { action: 'wait', memory: turn };
}
