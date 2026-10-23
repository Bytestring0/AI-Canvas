import {step, validateResponse} from './engine.js';

// outputs: per player null (dead or absent) or a settled-like
// {status:'fulfilled', value:{moves, memory?}} | {status:'rejected', reason}.
export function resolveTick(state, outputs) {
  const orders = outputs.map((out, pid) => {
    if (!state.players[pid].alive || !out) return null;
    if (out.status === 'rejected') return {error: String(out.reason?.message || out.reason || '策略执行失败')};
    try {
      validateResponse(out.value);
      return {moves: out.value.moves};
    } catch (reason) {
      return {error: String(reason?.message || reason)};
    }
  });
  return {orders, state: step(state, orders)};
}

// Replay snapshots keep the full board; fog memory is preserved only for humans.
export function snapshot(state, humanPids = []) {
  return {
    tick: state.tick, width: state.width, height: state.height, maxTicks: state.maxTicks,
    openCount: state.openCount, teamMode: state.teamMode,
    terrain: state.terrain.slice(), owner: state.owner.slice(), army: state.army.slice(),
    players: state.players.map(p => ({id: p.id, team: p.team, alive: p.alive, eliminatedTick: p.eliminatedTick,
      kills: p.kills, error: p.error, armyTotal: p.armyTotal, landTotal: p.landTotal, cities: p.cities})),
    finished: state.finished, winnerTeam: state.winnerTeam, events: [...state.events],
    seen: Object.fromEntries(humanPids.filter(pid => state.players[pid].alive).map(pid => [pid, state.seen[pid].slice()])),
  };
}
