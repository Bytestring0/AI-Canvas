import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES_VERSION, LEVELS, LAND_PERIOD, MAX_MOVES, MAX_PLAYERS, TERRAIN,
  seeded, createGame, step, observation, validateResponse, score, rank, visibleMask,
} from '../ui/engine.js';
import {resolveTick, snapshot} from '../ui/game.js';
import {BASELINE} from '../ui/baseline.js';
import {productionRate} from '../ui/engine.js';

test('production scales at exact stage boundaries for cities, generals and land', () => {
  for (const tick of [198,199,200,223,224,399,400,1599]) {
    let s=fixture({tick,maxTicks:2000});
    const city=at(s,3,2),land=at(s,2,1),neutral=at(s,4,2);
    s.owner[city]=0;s.owner[land]=0;s.army[land]=5;
    s.terrain[neutral]=TERRAIN.CITY;s.army[neutral]=40;
    const next=step(s,[]),gain=1+Math.floor(tick/200);
    assert.equal(productionRate(tick),gain);
    assert.equal(next.army[at(s,1,1)],1+gain);
    assert.equal(next.army[city],10+gain);
    assert.equal(next.army[land],5+((tick+1)%25===0?gain:0));
    assert.equal(next.army[neutral],40);
  }
});

test('land and survival scoring do not penalize larger maps or shorter games', () => {
  const state=fixture({tick:100,maxTicks:800});
  state.players[0].landTotal=3;state.players[1].landTotal=1;
  assert.equal(score(state,0).land,1500);
  assert.equal(score(state,0).survive,500);
  state.players[1].eliminatedTick=25;
  assert.equal(score(state,1).survive,125);
  const larger={...state,openCount:state.openCount*10,maxTicks:1600};
  assert.deepEqual(score(larger,0),score(state,0));
});

test('map areas are clearly separated and cities scale for small and full rosters', () => {
  for(const n of [2,4,16]){
    let previous=0;
    for(const level of Object.keys(LEVELS)){
      const s=createGame('scale-check',Array.from({length:n},()=>({})),level);
      const area=s.width*s.height;
      assert(area>previous);previous=area;
      assert.equal([...s.terrain].filter(t=>t===TERRAIN.CITY).length,LEVELS[level].cities(n));
    }
  }
});

const compile = source => {
  const decide = new Function(source + '; return decide;')();
  if (typeof decide !== 'function') throw Error('baseline must define decide');
  return decide;
};

// A small fixed board: 8×6, border mountains, two generals, one neutral city, one mountain.
function fixture({teams = [0, 1], tick = 0, maxTicks = 50} = {}) {
  const width = 8, height = 6, total = width * height;
  const terrain = new Uint8Array(total), owner = new Int8Array(total).fill(-1), army = new Int32Array(total);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) terrain[y * width + x] = TERRAIN.MOUNTAIN;
  const set = (x, y, t, o = -1, a = 0) => {const p = y * width + x; terrain[p] = t; owner[p] = o; army[p] = a};
  set(1, 1, TERRAIN.GENERAL, 0, 1);
  set(6, 4, TERRAIN.GENERAL, 1, 1);
  set(3, 2, TERRAIN.CITY, -1, 10);
  set(2, 3, TERRAIN.MOUNTAIN);
  let openCount = 0;
  for (const t of terrain) if (t !== TERRAIN.MOUNTAIN) openCount++;
  const state = {
    version: RULES_VERSION, seed: 'fixture', level: 'fixture', teamMode: teams[0] === teams[1],
    width, height, maxTicks, openCount, terrain, owner, army,
    players: teams.map((team, id) => ({id, name: `玩家${id + 1}`, team, alive: true, eliminatedTick: null, kills: 0, error: null,
      general: id === 0 ? 9 : 34, armyTotal: 1, landTotal: 1, cities: 0})),
    seen: teams.map(() => new Uint8Array(total)),
    finished: false, winnerTeam: null, events: [],
    tick,
  };
  for (const p of state.players) { // same initial discovery createGame performs
    const mask = visibleMask(state, p.id);
    for (let i = 0; i < total; i++) state.seen[p.id][i] |= mask[i];
  }
  return state;
}
const at = (state, x, y) => y * state.width + x;

test('games are reproducible, connected, and well formed for every level and roster', () => {
  for (const level of Object.keys(LEVELS)) for (const roster of [[{team: 0}, {team: 1}], [{team: 0}, {team: 0}, {team: 1}, {team: 1}], [{}, {}, {}, {}, {}]]) {
    const game = createGame('seed-1', roster, level);
    assert.deepEqual(game, createGame('seed-1', roster, level));
    assert.notDeepEqual(game.terrain, createGame('seed-2', roster, level).terrain);
    assert.equal(game.teamMode, new Set(roster.map(r => r.team ?? roster.indexOf(r))).size < roster.length);
    const distances = game.players.map(p => {
      const d = new Int32Array(game.width * game.height).fill(-1);
      d[p.general] = 0;
      const queue = [p.general];
      while (queue.length) {
        const cell = queue.shift(), x = cell % game.width, y = (cell / game.width) | 0;
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= game.width || ny >= game.height) continue;
          const np = ny * game.width + nx;
          if (game.terrain[np] === TERRAIN.MOUNTAIN || d[np] >= 0) continue;
          d[np] = d[cell] + 1; queue.push(np);
        }
      }
      return d;
    });
    let open = 0;
    for (let i = 0; i < game.terrain.length; i++) {
      if (game.terrain[i] === TERRAIN.MOUNTAIN) continue;
      open++;
      for (const d of distances) assert.ok(d[i] >= 0, 'every open cell must be reachable');
    }
    assert.equal(open, game.openCount);
    for (let a = 0; a < game.players.length; a++) for (let b = a + 1; b < game.players.length; b++) {
      const direct = distances[a][game.players[b].general];
      assert.ok(direct >= 6, `generals must be spread apart (got ${direct})`);
    }
    for (const p of game.players) {
      assert.equal(game.terrain[p.general], TERRAIN.GENERAL);
      assert.equal(game.owner[p.general], p.id);
      assert.equal(game.army[p.general], 1);
    }
    let cities = 0;
    for (let i = 0; i < game.terrain.length; i++) if (game.terrain[i] === TERRAIN.CITY) {
      cities++;
      assert.ok(game.army[i] >= 40 && game.army[i] <= 50);
    }
    assert.equal(cities, LEVELS[level].cities(roster.length));
  }
});

test('roster validation rejects impossible matches', () => {
  assert.throws(() => createGame('s', [{team: 0}], 'standard'));
  assert.throws(() => createGame('s', Array.from({length: MAX_PLAYERS + 1}, (_, i) => ({team: i})), 'standard'));
  assert.throws(() => createGame('s', [{team: -1}, {team: 0}], 'standard'));
  assert.throws(() => createGame('s', [{team: 99}, {team: 0}], 'standard'));
  assert.throws(() => createGame('s', [{team: 0}, {team: 1}], 'nowhere'));
});

test('half and full moves, reinforcement, and ignored illegal moves', () => {
  let s = fixture();
  s.army[at(s, 1, 1)] = 5;
  s = step(s, [{moves: [{from: {x: 1, y: 1}, dir: 'right', half: true}]}]);
  assert.equal(s.army[at(s, 1, 1)], 4); // 5 - 2 moved, then general production +1
  assert.equal(s.owner[at(s, 2, 1)], 0);
  assert.equal(s.army[at(s, 2, 1)], 2);
  s.army[at(s, 1, 1)] = 9;
  s = step(s, [{moves: [{from: {x: 1, y: 1}, dir: 'right', half: false}]}]);
  assert.equal(s.army[at(s, 1, 1)], 2); // 1 left behind, then +1
  assert.equal(s.army[at(s, 2, 1)], 10); // 8 arrived plus the 2 already there
  s.owner[at(s, 2, 2)] = 0; s.army[at(s, 2, 2)] = 4; // own tile above the mountain at (2,3)
  const before = structuredClone(s);
  const illegal = [
    {from: {x: 2, y: 2}, dir: 'down'},  // into mountain
    {from: {x: 2, y: 2}, dir: 'wait'},  // not a direction
    {from: {x: 0, y: 0}, dir: 'right'}, // out of bounds / border mountain
    {from: {x: 6, y: 4}, dir: 'left'},  // foreign tile
    {from: {x: 1, y: 2}, dir: 'left'},  // neutral tile, not ours
    {from: {x: 1, y: 1}, dir: 'left'},
  ];
  for (const bad of illegal) s = step(s, [{moves: [bad]}]);
  assert.equal(s.army[at(s, 1, 1)], before.army[at(s, 1, 1)] + illegal.length); // only production changed the board
  assert.deepEqual(Array.from(s.owner), Array.from(before.owner));
  for (let i = 0; i < s.army.length; i++) {
    if (s.terrain[i] === TERRAIN.MOUNTAIN || i === at(s, 6, 4)) continue; // generals produce every tick
    if (i === at(s, 1, 1)) continue;
    assert.equal(s.army[i], before.army[i], `tile ${i} should be untouched`);
  }
  // a 1-army tile can never move
  s.owner[at(s, 4, 2)] = 0; s.army[at(s, 4, 2)] = 1;
  s = step(s, [{moves: [{from: {x: 4, y: 2}, dir: 'right'}]}]);
  assert.equal(s.owner[at(s, 4, 2)], 0);
  assert.equal(s.owner[at(s, 5, 2)], -1);
});

test('combat: capture, stalemate at zero, and team reinforcement never captures', () => {
  let s = fixture();
  s.owner[at(s, 2, 1)] = 1; s.army[at(s, 2, 1)] = 3; // enemy neighbour of P0 general
  s.army[at(s, 1, 1)] = 6;
  s = step(s, [{moves: [{from: {x: 1, y: 1}, dir: 'right'}]}, null]); // k=3 vs 3: defender holds 0
  assert.equal(s.owner[at(s, 2, 1)], 1);
  assert.equal(s.army[at(s, 2, 1)], 0);
  s.army[at(s, 1, 1)] = 9;
  s = step(s, [{moves: [{from: {x: 1, y: 1}, dir: 'right'}]}, null]); // k=4 vs 0
  assert.equal(s.owner[at(s, 2, 1)], 0);
  assert.equal(s.army[at(s, 2, 1)], 4);
  s.army[at(s, 1, 1)] = 12;
  s = step(s, [{moves: [{from: {x: 1, y: 1}, dir: 'right'}]}, null]); // k=6 reinforces our 4 armies
  assert.equal(s.owner[at(s, 2, 1)], 0);
  assert.equal(s.army[at(s, 2, 1)], 10);
  // neutral city needs the full garrison beaten
  s.owner[at(s, 3, 1)] = 0; s.army[at(s, 3, 1)] = 14;
  s = step(s, [{moves: [{from: {x: 3, y: 1}, dir: 'down', half: false}]}]); // k=13 vs 10 city
  assert.equal(s.owner[at(s, 3, 2)], 0);
  assert.equal(s.army[at(s, 3, 2)], 4); // 3 survivors, then owned-city production +1
  // teammates reinforce instead of fighting
  let team = fixture({teams: [0, 0]});
  team.owner[at(team, 2, 1)] = 1; team.army[at(team, 2, 1)] = 2;
  team.army[at(team, 1, 1)] = 8;
  team = step(team, [{moves: [{from: {x: 1, y: 1}, dir: 'right'}]}, null]);
  assert.equal(team.owner[at(team, 2, 1)], 1);
  assert.equal(team.army[at(team, 2, 1)], 6);
});

test('capturing a general eliminates the victim and halves their territory', () => {
  let s = fixture();
  s.owner[at(s, 5, 4)] = 1; s.army[at(s, 5, 4)] = 10;
  s.owner[at(s, 6, 3)] = 1; s.army[at(s, 6, 3)] = 7;
  s.army[at(s, 6, 4)] = 3; // P1 general
  s.owner[at(s, 5, 3)] = 0; s.army[at(s, 5, 3)] = 20;
  s = step(s, [{moves: [
    {from: {x: 5, y: 3}, dir: 'down', half: false},  // 19 vs 10: P0 takes (5,4) with 9
    {from: {x: 5, y: 4}, dir: 'right', half: false}, // 8 vs 3: the general falls, 5 remain
  ]}, null]);
  const victim = s.players[1];
  assert.equal(victim.alive, false);
  assert.equal(victim.eliminatedTick, 1);
  assert.equal(s.players[0].kills, 1);
  assert.equal(s.terrain[at(s, 6, 4)], TERRAIN.CITY); // the general became a city
  assert.equal(s.owner[at(s, 6, 4)], 0);
  assert.equal(s.army[at(s, 6, 4)], 7); // halved garrison 1 + remain 5, then city production
  assert.equal(s.owner[at(s, 5, 4)], 0);
  assert.equal(s.army[at(s, 5, 4)], 1); // 9 captured, then 8 marched on to the general
  assert.equal(s.owner[at(s, 6, 3)], 0);
  assert.equal(s.army[at(s, 6, 3)], 3);
  assert.equal(s.finished, true);
  assert.equal(s.winnerTeam, 0);
});

test('a failing strategy leaves neutral land and a neutral city behind', () => {
  let s = fixture();
  s.owner[at(s, 5, 4)] = 1; s.army[at(s, 5, 4)] = 9;
  s = step(s, [null, {error: '超时'}]);
  assert.equal(s.players[1].alive, false);
  assert.equal(s.players[1].error, '超时');
  assert.equal(s.owner[at(s, 6, 4)], -1);
  assert.equal(s.terrain[at(s, 6, 4)], TERRAIN.CITY);
  assert.equal(s.army[at(s, 6, 4)], 1); // neutral tiles never produce afterwards
  assert.equal(s.owner[at(s, 5, 4)], -1);
  assert.equal(s.army[at(s, 5, 4)], 9);
  assert.equal(s.finished, true);
  assert.equal(score(s, 1).total, 0);
});

test('generals and cities produce every tick, land every 25 ticks', () => {
  let s = fixture();
  s.owner[at(s, 2, 1)] = 0; s.army[at(s, 2, 1)] = 5;
  s.owner[at(s, 3, 2)] = 0; s.army[at(s, 3, 2)] = 10; // owned city
  for (let i = 0; i < 25; i++) s = step(s, []);
  assert.equal(s.tick, 25);
  assert.equal(s.army[at(s, 1, 1)], 26); // general 1 + 25 ticks
  assert.equal(s.army[at(s, 3, 2)], 35); // city 10 + 25
  assert.equal(s.army[at(s, 2, 1)], 6); // land gained exactly one army at tick 25
  assert.equal(s.players[0].armyTotal, 26 + 35 + 6);
  assert.equal(s.players[0].landTotal, 3);
  assert.equal(s.players[0].cities, 1);
});

test('first-mover order rotates every tick', () => {
  let s = fixture();
  s.army[at(s, 1, 1)] = 2; s.army[at(s, 2, 2)] = 0;
  s.owner[at(s, 2, 2)] = 1; s.army[at(s, 2, 2)] = 2;
  s = step(s, [
    {moves: [{from: {x: 1, y: 1}, dir: 'right'}]},
    {moves: [{from: {x: 2, y: 2}, dir: 'up'}]},
  ]);
  // tick 0: P0 moved first, grabbed (2,1) with 1; P1 then hit 1 vs 1 → defender keeps 0
  assert.equal(s.owner[at(s, 2, 1)], 0);
  assert.equal(s.army[at(s, 2, 1)], 0);
  let t = fixture({tick: 1});
  t.army[at(t, 1, 1)] = 2;
  t.owner[at(t, 2, 2)] = 1; t.army[at(t, 2, 2)] = 2;
  t = step(t, [
    {moves: [{from: {x: 1, y: 1}, dir: 'right'}]},
    {moves: [{from: {x: 2, y: 2}, dir: 'up'}]},
  ]);
  // tick 1: P1 moved first and owns the contested tile
  assert.equal(t.owner[at(t, 2, 1)], 1);
  assert.equal(t.army[at(t, 2, 1)], 0);
});

test('fog: terrain discoveries persist, ownership is only live, memory round-trips', () => {
  let s = fixture();
  s.owner[at(s, 2, 1)] = 0; s.army[at(s, 2, 1)] = 4; // P0 takes the tile east of its general
  const obs = observation(s, 0, {note: 'hi'});
  assert.deepEqual(obs.you, {id: 0, team: 0, general: {x: 1, y: 1}, alive: true});
  assert.equal(obs.memory.note, 'hi');
  assert.equal(obs.terrain[1][1], TERRAIN.GENERAL); // own general at (x=1,y=1)
  assert.equal(obs.terrain[4][6], -1);              // enemy general at (x=6,y=4) never seen
  assert.equal(obs.owner[1][1], 0);                 // (1,1)
  assert.equal(obs.owner[1][2], 0);                 // (2,1)
  assert.equal(obs.owner[2][3], -1);                // neutral city (3,2) is visible right now
  assert.equal(obs.army[2][3], 10);
  assert.equal(obs.owner[4][5], -2);                // (5,4) is in fog: ownership unknown
  assert.equal(obs.army[4][5], -1);
  assert.deepEqual(obs.players[0], {id: 0, team: 0, alive: true, army: s.players[0].armyTotal, land: s.players[0].landTotal});
  s = step(s, []); // discovery refreshes while (2,1) is still ours
  s.owner[at(s, 2, 1)] = 1; s.army[at(s, 2, 1)] = 9; // the tile falls to the enemy, outside P0 sight
  const later = observation(s, 0);
  assert.equal(later.terrain[2][3], TERRAIN.CITY);   // terrain stays revealed after discovery
  assert.equal(later.owner[2][3], -2);               // but ownership went dark
  assert.equal(later.army[2][3], -1);
  assert.equal(later.terrain[4][6], -1);             // the enemy general was never discovered
});

test('responses are validated strictly but illegal battlefield moves are merely skipped', () => {
  const s = fixture();
  assert.throws(() => validateResponse(null));
  assert.throws(() => validateResponse([]));
  assert.throws(() => validateResponse({}));
  assert.throws(() => validateResponse({moves: {}}));
  assert.throws(() => validateResponse({moves: Array.from({length: MAX_MOVES + 1}, () => ({from: {x: 1, y: 1}, dir: 'up'}))}));
  assert.throws(() => validateResponse({moves: [{from: {x: 1, y: 1}, dir: 'fly'}]}));
  assert.throws(() => validateResponse({moves: [{from: [1, 1], dir: 'up'}]}));
  assert.throws(() => validateResponse({moves: [{from: {x: 1, y: 1}, dir: 'up', half: 1}]}));
  assert.doesNotThrow(() => validateResponse({moves: []}));
  assert.doesNotThrow(() => validateResponse({moves: [{from: {x: 1, y: 1}, dir: 'up'}], memory: {a: 1}}));
});

test('scoring bounds, winner bonus, and deterministic ranking', () => {
  let s = fixture();
  s.maxTicks = 10;
  s.owner[at(s, 2, 1)] = 0; s.army[at(s, 2, 1)] = 3;
  for (let i = 0; i < 10; i++) s = step(s, []);
  assert.equal(s.finished, true);
  const w = score(s, 0), l = score(s, 1);
  assert.equal(w.win + l.win, 4000);
  assert.equal(w.survive, 500);
  assert.ok(w.total > l.total);
  assert.ok(w.total <= 10000 && w.total >= 0);
  assert.equal(score({...structuredClone(s), players: s.players.map(p => ({...p, error: 'x'}))}, 0).total, 0);
  assert.equal(rank(s)[0].id, 0);
  assert.equal(rank(fixture())[0].id, 0); // a perfect tie falls back to the lower player id
  const ahead = fixture();
  ahead.players[1].landTotal = ahead.players[0].landTotal + 1;
  assert.equal(rank(ahead)[0].id, 1); // otherwise land breaks the tie
});

test('timeout awards the army leader', () => {
  let s = fixture({maxTicks: 3});
  s.owner[at(s, 2, 1)] = 0; s.army[at(s, 2, 1)] = 40;
  for (let i = 0; i < 3; i++) s = step(s, []);
  assert.equal(s.finished, true);
  assert.equal(s.winnerTeam, 0);
});

test('baseline versus baseline games replay identically and always resolve', () => {
  const play = (seedValue, roster, level) => {
    let state = createGame(seedValue, roster, level);
    const brains = roster.map(() => compile(BASELINE.source));
    const memories = roster.map(() => null);
    let guard = 0;
    while (!state.finished && guard++ <= state.maxTicks + 5) {
      const outputs = state.players.map((p, i) => {
        if (!p.alive) return null;
        try {
          const value = brains[i](observation(state, i, memories[i]));
          validateResponse(value);
          memories[i] = value.memory ?? null;
          return {status: 'fulfilled', value};
        } catch (reason) {return {status: 'rejected', reason}}
      });
      state = resolveTick(state, outputs).state;
    }
    return state;
  };
  for (const [seedValue, roster, level] of [
    ['base-2p', [{team: 0}, {team: 1}], 'compact'],
    ['base-4p', [{}, {}, {}, {}], 'compact'],
    ['base-2v2', [{team: 0}, {team: 0}, {team: 1}, {team: 1}], 'compact'],
  ]) {
    const a = play(seedValue, roster, level), b = play(seedValue, roster, level);
    assert.deepEqual(a, b);
    assert.equal(a.finished, true);
    assert.notEqual(a.winnerTeam, null);
    for (const p of a.players) {
      const sc = score(a, p.id);
      assert.ok(sc.total >= 0 && sc.total <= 10000);
      assert.ok(p.armyTotal >= 0);
    }
  }
});

test('snapshots keep the board and only living humans keep fog memory', () => {
  const s = fixture();
  const snap = snapshot(s, [0, 1]);
  assert.equal(snap.tick, 0);
  assert.deepEqual(Array.from(snap.owner), Array.from(s.owner));
  assert.ok(snap.seen[0] instanceof Uint8Array);
  const gone = step(s, [null, {error: 'x'}]);
  const later = snapshot(gone, [1]);
  assert.equal(later.seen[1], undefined); // the dead human's memory is dropped
  assert.doesNotThrow(() => score(later, 0));
  assert.doesNotThrow(() => rank(later));
});
