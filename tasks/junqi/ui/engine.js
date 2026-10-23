// Pure deterministic simulation of a generals.io-style fog-of-war conquest game.
// Rendering speed and strategy execution time never enter the rules.
export const RULES_VERSION = 'junqi-2';
export const TICKS_PER_SECOND = 2; // 1× playback target: 2 ticks per second
export const LAND_PERIOD = 25;     // plain owned land produces every 25 ticks
export const MAX_MOVES = 4;        // orders a player may submit per tick
export const MAX_PLAYERS = 16;
export const GROWTH_PERIOD = 200;
// The production phase completing ticks 1..200 yields +1, 201..400 +2, etc.
export const productionRate = tick => 1 + Math.floor(tick / GROWTH_PERIOD);
export const LEVELS = {
  compact: {name: '紧凑', maxTicks: 800,  width: p => 7 + 2 * p,  height: p => 6 + 2 * p,  mountain: .15, cities: p => 2 * p + 2},
  standard: {name: '标准', maxTicks: 1200, width: p => 8 + 2 * p,  height: p => 7 + 2 * p,  mountain: .18, cities: p => 2 * p + 2},
  vast: {name: '辽阔', maxTicks: 1600, width: p => 11 + 3 * p, height: p => 10 + 3 * p, mountain: .20, cities: p => 4 * p + 4},
};
export const DIRS = {up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0]};
const DIR_LIST = Object.values(DIRS);
export const TERRAIN = {EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3};

export function seeded(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296};
}
function shuffle(a, rng) {for (let i = a.length - 1; i > 0; i--) {const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]} return a}
const label = pid => `玩家${pid + 1}`;
const nameOf = (s, pid) => s.players[pid]?.name || label(pid);

function bfsDistances(terrain, width, height, from) {
  const total = width * height, d = new Int32Array(total).fill(-1);
  d[from] = 0;
  const queue = [from];
  for (let h = 0; h < queue.length; h++) {
    const p = queue[h], x = p % width, y = (p / width) | 0;
    for (const [dx, dy] of DIR_LIST) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (terrain[np] === TERRAIN.MOUNTAIN || d[np] >= 0) continue;
      d[np] = d[p] + 1;
      queue.push(np);
    }
  }
  return d;
}

export function createGame(seed = 'canvas', roster, level = 'standard') {
  if (!LEVELS[level]) throw Error('未知场地');
  if (!Array.isArray(roster) || roster.length < 2 || roster.length > MAX_PLAYERS) throw Error(`参赛人数须为 2~${MAX_PLAYERS}`);
  const teams = roster.map((r, i) => Number.isInteger(r?.team) ? r.team : i);
  if (teams.some(t => t < 0 || t >= MAX_PLAYERS)) throw Error('队伍编号超出范围');
  const n = roster.length, rules = LEVELS[level];
  const teamMode = new Set(teams).size < teams.length;
  const width = rules.width(n), height = rules.height(n), total = width * height;
  const rng = seeded(`${RULES_VERSION}:${seed}:${level}:${n}`);

  // Border ring is mountain; interior is random mountain, then only the largest
  // connected open region stays passable so every open cell is mutually reachable.
  const terrain = new Uint8Array(total);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    terrain[y * width + x] = (x === 0 || y === 0 || x === width - 1 || y === height - 1) ? TERRAIN.MOUNTAIN : (rng() < rules.mountain ? TERRAIN.MOUNTAIN : TERRAIN.EMPTY);
  const region = new Int32Array(total).fill(-1);
  let bestRegion = -1, bestSize = 0, regionId = 0;
  for (let i = 0; i < total; i++) {
    if (terrain[i] !== TERRAIN.EMPTY || region[i] >= 0) continue;
    let size = 0;
    const queue = [i];
    region[i] = regionId;
    while (queue.length) {
      const p = queue.pop();
      size++;
      const x = p % width, y = (p / width) | 0;
      for (const [dx, dy] of DIR_LIST) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (terrain[np] === TERRAIN.EMPTY && region[np] < 0) {region[np] = regionId; queue.push(np)}
      }
    }
    if (size > bestSize) {bestSize = size; bestRegion = regionId}
    regionId++;
  }
  for (let i = 0; i < total; i++) if (terrain[i] === TERRAIN.EMPTY && region[i] !== bestRegion) terrain[i] = TERRAIN.MOUNTAIN;
  const open = [];
  for (let i = 0; i < total; i++) if (terrain[i] === TERRAIN.EMPTY) open.push(i);

  // Generals: farthest-point sampling with seeded tie-breaks keeps spawns apart.
  const order = shuffle([...open], rng);
  const generals = [order[0]];
  const distances = [bfsDistances(terrain, width, height, order[0])];
  for (let k = 1; k < n; k++) {
    let pick = -1, score = -1;
    for (const c of order) {
      if (generals.includes(c)) continue;
      let nearest = Infinity;
      for (const d of distances) nearest = Math.min(nearest, d[c]);
      if (nearest > score) {score = nearest; pick = c}
    }
    generals.push(pick);
    distances.push(bfsDistances(terrain, width, height, pick));
  }

  // Neutral cities: away from every general and from each other; garrison 40/42/…/50.
  const wanted = rules.cities(n), cities = [];
  const candidates = shuffle(open.filter(c => !generals.includes(c)), rng);
  for (const c of candidates) {
    if (cities.length >= wanted) break;
    if (distances.some(d => d[c] >= 0 && d[c] < 5)) continue;
    const x = c % width, y = (c / width) | 0;
    if (cities.some(o => Math.abs(o % width - x) + Math.abs(((o / width) | 0) - y) < 3)) continue;
    cities.push(c);
  }
  for (const c of candidates) { // relax the general-distance rule if the map ran crowded
    if (cities.length >= wanted) break;
    const x = c % width, y = (c / width) | 0;
    if (cities.some(o => Math.abs(o % width - x) + Math.abs(((o / width) | 0) - y) < 3)) continue;
    cities.push(c);
  }
  const owner = new Int8Array(total).fill(-1);
  const army = new Int32Array(total);
  for (const c of cities) {terrain[c] = TERRAIN.CITY; army[c] = 40 + 2 * Math.floor(rng() * 6)}
  for (let i = 0; i < n; i++) {const g = generals[i]; terrain[g] = TERRAIN.GENERAL; owner[g] = i; army[g] = 1}

  const state = {
    version: RULES_VERSION, seed: String(seed), level, teamMode, width, height, maxTicks: rules.maxTicks, tick: 0,
    openCount: open.length, terrain, owner, army,
    players: roster.map((r, i) => ({id: i, name: typeof r?.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : label(i), team: teams[i], alive: true, eliminatedTick: null, kills: 0, error: null, general: generals[i], armyTotal: 1, landTotal: 1, cities: 0})),
    seen: roster.map(() => new Uint8Array(total)),
    finished: false, winnerTeam: null,
    events: [`对局开始 · ${n} 名玩家 · ${width}×${height} · ${open.length} 格可行土地`],
  };
  recompute(state);
  discover(state);
  return state;
}

function cloneState(s) {
  return {...s, terrain: s.terrain.slice(), owner: s.owner.slice(), army: s.army.slice(),
    players: s.players.map(p => ({...p})), seen: s.seen.map(a => a.slice()), events: [...s.events]};
}

// Vision is the 8-neighbourhood (Chebyshev distance 1) around every owned tile.
export function visibleMask(s, pid) {
  const w = s.width, h = s.height, mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (s.owner[y * w + x] !== pid) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) mask[ny * w + nx] = 1;
    }
  }
  return mask;
}
function discover(s) {
  for (const p of s.players) {
    if (!p.alive) continue;
    const mask = visibleMask(s, p.id), seen = s.seen[p.id];
    for (let i = 0; i < seen.length; i++) seen[i] = seen[i] | mask[i];
  }
}
function recompute(s) {
  for (const p of s.players) {p.armyTotal = 0; p.landTotal = 0; p.cities = 0}
  for (let i = 0; i < s.owner.length; i++) {
    const o = s.owner[i];
    if (o < 0) continue;
    const p = s.players[o];
    p.armyTotal += s.army[i];
    p.landTotal++;
    if (s.terrain[i] === TERRAIN.CITY) p.cities++;
  }
}

// A failing strategy (or a crashed worker) leaves the map instead of transferring land.
function neutralize(s, pid, reason, isError) {
  for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === pid) {
    s.owner[i] = -1;
    if (s.terrain[i] === TERRAIN.GENERAL) s.terrain[i] = TERRAIN.CITY;
  }
  const player = s.players[pid];
  player.alive = false;
  player.eliminatedTick = s.tick + 1;
  if (isError) player.error = String(reason).slice(0, 300);
  s.events.push(`${nameOf(s, pid)} 出局${isError ? `：策略错误（${String(reason).slice(0, 120)}）` : ''}，领土变为中立`);
}
function transferAll(s, victimId, captorId) {
  for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === victimId) {
    s.owner[i] = captorId;
    s.army[i] = Math.max(1, Math.floor(s.army[i] / 2));
    if (s.terrain[i] === TERRAIN.GENERAL) s.terrain[i] = TERRAIN.CITY;
  }
  const victim = s.players[victimId];
  victim.alive = false;
  victim.eliminatedTick = s.tick + 1;
  s.players[captorId].kills++;
}

function applyMove(s, pid, move) {
  const w = s.width, h = s.height;
  const from = move?.from;
  if (!from || !Number.isInteger(from.x) || !Number.isInteger(from.y)) return false;
  const fp = from.y * w + from.x;
  const delta = DIRS[move.dir];
  if (!delta || from.x < 0 || from.y < 0 || from.x >= w || from.y >= h) return false;
  if (s.owner[fp] !== pid || s.army[fp] < 2) return false;
  const tx = from.x + delta[0], ty = from.y + delta[1];
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
  const tp = ty * w + tx;
  if (s.terrain[tp] === TERRAIN.MOUNTAIN) return false;
  const n = s.army[fp];
  const k = move.half === false ? n - 1 : Math.floor(n / 2);
  s.army[fp] -= k;
  const to = s.owner[tp];
  if (to === pid || (to >= 0 && s.players[to].team === s.players[pid].team)) {
    s.army[tp] += k; // reinforcement never captures a teammate tile
    return true;
  }
  const defense = s.army[tp];
  if (k <= defense) {
    s.army[tp] = defense - k; // defender holds the tile, possibly at 0 armies
    return true;
  }
  const remain = k - defense;
  if (s.terrain[tp] === TERRAIN.GENERAL) {
    const victim = to;
    transferAll(s, victim, pid); // halves and converts the fallen general into a city
    s.army[tp] += remain;
    s.events.push(`${nameOf(s, pid)} 攻陷了 ${nameOf(s, victim)} 的将军，其领土减半转让`);
  } else {
    s.owner[tp] = pid;
    s.army[tp] = remain;
    if (s.terrain[tp] === TERRAIN.CITY) s.events.push(`${nameOf(s, pid)} 占领城市 (${tx},${ty})`);
  }
  return true;
}

function produce(s) {
  const landTick = (s.tick + 1) % LAND_PERIOD === 0;
  const gain = productionRate(s.tick);
  for (let i = 0; i < s.owner.length; i++) {
    if (s.owner[i] < 0 || s.terrain[i] === TERRAIN.MOUNTAIN) continue;
    if (s.terrain[i] === TERRAIN.EMPTY) {if (landTick) s.army[i] += gain}
    else s.army[i] += gain;
  }
}

function aliveTeams(s) {
  const teams = new Set();
  for (const p of s.players) if (p.alive) teams.add(p.team);
  return [...teams];
}
function leadingTeam(s) {
  const stats = new Map();
  for (const p of s.players) {
    if (!stats.has(p.team)) stats.set(p.team, {team: p.team, army: 0, land: 0});
    const row = stats.get(p.team);
    row.army += p.armyTotal;
    row.land += p.landTotal;
  }
  return [...stats.values()].sort((a, b) => b.army - a.army || b.land - a.land || a.team - b.team)[0]?.team ?? null;
}

// orders: array indexed by player id of null | {moves: [...]} | {error: 'message'}.
export function step(prev, orders = []) {
  if (prev.finished) return prev;
  const s = cloneState(prev);
  s.events = [];
  const P = s.players.length;
  for (let pid = 0; pid < P; pid++) {
    if (orders[pid]?.error && s.players[pid].alive) neutralize(s, pid, orders[pid].error, true);
  }
  for (let i = 0; i < P; i++) {
    const pid = (prev.tick + i) % P; // first-mover advantage rotates every tick
    const player = s.players[pid];
    if (!player.alive) continue;
    const moves = Array.isArray(orders[pid]?.moves) ? orders[pid].moves.slice(0, MAX_MOVES) : [];
    for (const move of moves) {
      if (!player.alive) break;
      applyMove(s, pid, move);
    }
  }
  produce(s);
  recompute(s);
  s.tick++;
  const teams = aliveTeams(s);
  const sideName = t => {
    if (s.teamMode) return `队伍${'甲乙丙丁'[t] ?? t + 1}`;
    return s.players.find(p => p.team === t)?.name ?? label(t);
  };
  if (teams.length <= 1) {
    s.finished = true;
    s.winnerTeam = teams[0] ?? null;
    s.events.push(teams.length ? `对局结束，${sideName(teams[0])} 获胜` : '对局结束，没有队伍幸存');
  } else if (s.tick >= s.maxTicks) {
    s.finished = true;
    s.winnerTeam = leadingTeam(s);
    s.events.push(`回合用尽，${sideName(s.winnerTeam)} 以军力优势判胜`);
  }
  discover(s);
  return s;
}

export function validateResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw Error('必须返回 JSON 对象');
  if (!Array.isArray(response.moves)) throw Error('必须返回 {moves: [...]},moves 为数组');
  if (response.moves.length > MAX_MOVES) throw Error(`每 tick 最多 ${MAX_MOVES} 条移动`);
  for (const move of response.moves) {
    if (!move || typeof move !== 'object' || Array.isArray(move)) throw Error('每条移动必须是对象');
    const from = move.from;
    if (!from || typeof from !== 'object' || Array.isArray(from) || !Number.isInteger(from.x) || !Number.isInteger(from.y)) throw Error('from 必须是 {x,y} 整数坐标');
    if (!Object.hasOwn(DIRS, move.dir)) throw Error('dir 必须是 up/right/down/left');
    if (move.half !== undefined && typeof move.half !== 'boolean') throw Error('half 必须是布尔值');
  }
  return response;
}

// Fog observation: terrain stays revealed once seen; ownership/armies only while visible.
export function observation(s, pid, memory = null) {
  const w = s.width, h = s.height, mask = visibleMask(s, pid), seen = s.seen[pid];
  const terrain = [], owner = [], army = [];
  for (let y = 0; y < h; y++) {
    const rowTerrain = [], rowOwner = [], rowArmy = [];
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      rowTerrain.push(seen[p] ? s.terrain[p] : -1);
      if (mask[p]) {rowOwner.push(s.owner[p]); rowArmy.push(s.army[p])}
      else {rowOwner.push(-2); rowArmy.push(-1)}
    }
    terrain.push(rowTerrain);
    owner.push(rowOwner);
    army.push(rowArmy);
  }
  const you = s.players[pid], g = you.general;
  return {
    version: RULES_VERSION, role: 'player', seed: s.seed,
    tick: s.tick, maxTicks: s.maxTicks, width: w, height: h, playerCount: s.players.length,
    you: {id: pid, team: you.team, general: {x: g % w, y: (g / w) | 0}, alive: you.alive},
    players: s.players.map(p => ({id: p.id, team: p.team, alive: p.alive, army: p.armyTotal, land: p.landTotal})),
    terrain, owner, army, memory,
  };
}

export function score(s, pid) {
  const p = s.players[pid];
  const parts = {win: 0, kills: 0, land: 0, army: 0, survive: 0};
  if (p.error) return {total: 0, ...parts};
  const winner = s.finished && s.winnerTeam !== null && p.team === s.winnerTeam;
  if (winner) parts.win = 4000;
  const enemies = Math.max(1, s.players.filter(q => q.team !== p.team).length);
  parts.kills = Math.floor(1500 * p.kills / enemies);
  const occupied = Math.max(1, s.players.reduce((sum, q) => sum + q.landTotal, 0));
  parts.land = Math.floor(2000 * p.landTotal / occupied);
  const allArmies = Math.max(1, s.players.reduce((sum, q) => sum + q.armyTotal, 0));
  parts.army = Math.floor(2000 * p.armyTotal / allArmies);
  const survived = p.eliminatedTick ?? s.tick;
  parts.survive = Math.floor(500 * Math.min(survived, s.tick) / Math.max(1, s.tick));
  return {total: Object.values(parts).reduce((a, b) => a + b, 0), ...parts};
}

export function rank(s) {
  return [...s.players].sort((a, b) => {
    const diff = score(s, b.id).total - score(s, a.id).total;
    if (diff) return diff;
    const living = (a.alive ? 0 : 1) - (b.alive ? 0 : 1);
    if (living) return living;
    return b.landTotal - a.landTotal || b.armyTotal - a.armyTotal || a.id - b.id;
  });
}
