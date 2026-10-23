// junqi-2: deterministic bounded search, expansion and general defense.
const JQ_DIRS = ["up", "right", "down", "left"];
const JQ_SEARCH_LIMIT = 360;
const JQ_SOURCE_LIMIT = 6;
const JQ_MEMORY_LIMIT = 160;
function jqHeapPush(heap, item) {
  let i = heap.length; heap.push(item);
  while (i > 0) {
    const p = (i - 1) >> 1, parent = heap[p];
    if (parent[0] < item[0] || (parent[0] === item[0] && parent[1] <= item[1])) break;
    heap[i] = parent; i = p;
  }
  heap[i] = item;
}
function jqHeapPop(heap) {
  const result = heap[0], last = heap.pop();
  if (heap.length === 0) return result;
  let i = 0;
  while (true) {
    let c = i * 2 + 1;
    if (c >= heap.length) break;
    if (c + 1 < heap.length && (heap[c + 1][0] < heap[c][0] ||
        (heap[c + 1][0] === heap[c][0] && heap[c + 1][1] < heap[c][1]))) c++;
    const child = heap[c];
    if (last[0] < child[0] || (last[0] === child[0] && last[1] <= child[1])) break;
    heap[i] = child; i = c;
  }
  heap[i] = last; return result;
}
function jqProduction(t) {
  t = Math.max(0, Math.floor(t));
  const q = Math.floor(t / 200), r = t % 200;
  return 100 * q * (q + 1) + r * (q + 1);
}
function jqHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function decide(o) {
  if (!o.you.alive) return { moves: [], memory: null };
  const W = o.width, H = o.height, V = W * H;
  const me = o.you.id, tick = o.tick;
  const g = 1 + Math.floor(tick / 200);
  const remaining = Math.max(0, o.maxTicks - tick);
  const general = o.you.general.y * W + o.you.general.x;
  const key = jqHash(String(o.seed)) + "|" + W + "|" + H + "|" + me;
  const seed = jqHash(key), rotation = (seed + tick + me) & 3;
  const old = o.memory && o.memory.v === 1 && o.memory.key === key && o.memory.tick < tick ? o.memory : null;
  const terrain = new Int8Array(V), owner = new Int16Array(V), army = new Float64Array(V);
  const unknownAround = new Uint8Array(V), players = new Map();
  for (const p of o.players) players.set(p.id, p);
  function allied(id) { const p = players.get(id); return id >= 0 && p && p.team === o.you.team; }
  function enemy(id) { const p = players.get(id); return id >= 0 && p && p.alive && p.team !== o.you.team; }
  function neighbor(i, d) {
    if (d === 0) return i >= W ? i - W : -1;
    if (d === 1) return i % W + 1 < W ? i + 1 : -1;
    if (d === 2) return i + W < V ? i + W : -1;
    return i % W > 0 ? i - 1 : -1;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; terrain[i] = o.terrain[y][x]; owner[i] = o.owner[y][x]; army[i] = o.army[y][x];
  }
  const sightings = new Map();
  if (old && Array.isArray(old.seen)) for (const r of old.seen.slice(0, JQ_MEMORY_LIMIT)) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) continue;
    const [i, who, n, when] = r;
    if (!Number.isInteger(i) || i < 0 || i >= V || !Number.isInteger(who) || who < -1 ||
        !Number.isInteger(when) || when < 0 || when > tick || n < 0) continue;
    if (terrain[i] === 2 || terrain[i] === 3 || tick - when <= 40) sightings.set(i, r);
  }
  for (let i = 0; i < V; i++) {
    if (owner[i] === -2) continue;
    if (terrain[i] === 2 || terrain[i] === 3 || (enemy(owner[i]) && army[i] >= 3)) {
      sightings.set(i, [i, owner[i], army[i], tick]);
    } else sightings.delete(i);
  }
  for (let i = 0; i < V; i++) {
    if (terrain[i] === 1) continue;
    const x = i % W, y = Math.floor(i / W); let count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && terrain[ny * W + nx] === -1) count++;
    }
    unknownAround[i] = count;
  }
  function rememberedOwner(i) {
    if (owner[i] !== -2) return owner[i];
    const r = sightings.get(i); return r ? r[1] : -2;
  }
  function defense(i) {
    if (owner[i] !== -2) return Math.max(0, army[i]);
    const r = sightings.get(i), special = terrain[i] === 2 || terrain[i] === 3;
    if (!r) return special ? 50 : 2;
    const age = tick - r[3];
    if (r[1] === -1) return special ? Math.max(50, r[2]) : r[2];
    if (r[1] === me) return special ? Math.max(50, r[2]) : 3;
    if (special) return r[2] + jqProduction(tick) - jqProduction(r[3]);
    return Math.max(2, r[2] * Math.max(0.25, 1 - age / 48)) + Math.ceil(age / 25) * g;
  }
  function distances(sources, maxDistance) {
    const dist = new Int32Array(V); dist.fill(-1);
    const queue = new Int32Array(V); let head = 0, tail = 0;
    for (const s of sources) {
      if (s < 0 || s >= V || terrain[s] === 1 || dist[s] >= 0) continue;
      dist[s] = 0; queue[tail++] = s;
    }
    while (head < tail) {
      const i = queue[head++]; if (dist[i] >= maxDistance) continue;
      for (let k = 0; k < 4; k++) {
        const j = neighbor(i, k);
        if (j < 0 || terrain[j] === 1 || dist[j] >= 0) continue;
        dist[j] = dist[i] + 1; queue[tail++] = j;
      }
    }
    return dist;
  }
  const homeDistance = distances([general], 8);
  let strongestNear = 0, closeA = 0, closeB = 0;
  for (let i = 0; i < V; i++) {
    const d = homeDistance[i]; if (d <= 0 || d > 8 || !enemy(owner[i])) continue;
    const threat = Math.max(0, army[i] - d), growthBeforeArrival = Math.max(0, Math.ceil(d / 4) - 1) * g;
    strongestNear = Math.max(strongestNear, threat - growthBeforeArrival);
    if (d <= 4) {
      if (threat > closeA) { closeB = closeA; closeA = threat; }
      else if (threat > closeB) closeB = threat;
    }
  }
  const homeReserve = Math.max(1, Math.ceil(Math.max(strongestNear, closeA + closeB) + (strongestNear > 0 ? g : 0)));
  function movable(i) {
    if (owner[i] !== me || army[i] < 2) return null;
    const reserve = i === general ? homeReserve : 1;
    if (army[i] - 1 >= 1 && reserve <= 1) return { count: army[i] - 1, half: false };
    const half = Math.floor(army[i] / 2);
    if (half >= 1 && army[i] - half >= reserve) return { count: half, half: true };
    return null;
  }
  let largest = 0;
  for (let i = 0; i < V; i++) if (owner[i] === me) largest = Math.max(largest, army[i]);
  const frontierTargets = [], cityTargets = [], generalTargets = [];
  const futureProduction = jqProduction(o.maxTicks) - jqProduction(tick);
  for (let i = 0; i < V; i++) {
    if (terrain[i] === 1 || owner[i] === me) continue;
    const who = rememberedOwner(i); if (who !== me && allied(who)) continue;
    frontierTargets.push(i); const defenders = defense(i);
    if (terrain[i] === 3 && enemy(who) && largest > defenders + 5) generalTargets.push(i);
    else if ((terrain[i] === 2 || terrain[i] === 3) && largest > defenders + 6 && futureProduction > defenders + 10) cityTargets.push(i);
  }
  const frontierDistance = distances(frontierTargets, V), cityDistance = distances(cityTargets, V);
  const generalDistance = distances(generalTargets, V), moves = [], blocked = new Uint8Array(V);
  let lastFrom = old && Number.isInteger(old.from) ? old.from : -1;
  let lastTo = old && Number.isInteger(old.to) ? old.to : -1;
  let selectedGoal = old && Number.isInteger(old.goal) ? old.goal : -1;
  function progress(field, s, i) { return field[s] >= 0 && field[i] >= 0 ? Math.max(0, field[s] - field[i]) : 0; }
  function endpointScore(s, i, steps, loss, first, capacity) {
    const who = owner[i], guessedWho = rememberedOwner(i);
    const homeNeed = (homeReserve > 1 ? Math.max(0, homeReserve + g - army[general]) : 0); let value = 0;
    if (who === me) {
      if (i === general && s !== general && homeNeed > 0) {
        const delivered = Math.max(0, capacity - loss), urgency = army[general] < homeReserve ? 100 : 22;
        value = urgency * Math.min(delivered, homeNeed);
      } else {
        value = 5 * progress(frontierDistance, s, i);
        if (capacity >= 14) {
          value = Math.max(value, 18 * progress(cityDistance, s, i));
          value = Math.max(value, 65 * progress(generalDistance, s, i));
        }
        if (s !== general && i === general && homeNeed === 0) value *= 0.2;
      }
    } else {
      if (guessedWho !== me && allied(guessedWho)) return -Infinity;
      const defenders = defense(i);
      if (terrain[i] === 3 && enemy(guessedWho)) {
        const p = players.get(guessedWho); value = 1800 + Math.min(1400, (p ? p.army : 0) * 0.6);
      } else if (terrain[i] === 2 || terrain[i] === 3) {
        const net = futureProduction - defenders; value = net > 0 ? 18 + Math.min(145, net * 0.25) : 2;
        if (enemy(guessedWho)) value += Math.min(35, futureProduction * 0.1);
      } else {
        value = 11 + Math.min(15, remaining * g / 100);
        if (enemy(guessedWho)) value += 8;
        value += unknownAround[i] * (remaining > 100 ? 2.1 : 0.4);
        if (who === -2) value *= 0.72;
      }
      value -= defenders * (remaining < 100 ? 1.2 : 0.16);
    }
    const combatLoss = Math.max(0, loss - steps); let score = value / (steps + 0.65 + combatLoss * 0.065);
    if (owner[i] !== me && i === selectedGoal) score *= 1.16;
    if (s === lastTo && first === lastFrom && !(i === general && homeNeed > 0) && !(terrain[i] === 3 && enemy(guessedWho))) score *= 0.32;
    const tie = (Math.imul(i + 1, 2654435761) ^ seed) >>> 0;
    return score + (tie % 997) * 0.0000001;
  }
  function search(source, movement) {
    const capacity = movement.count + 1, bestCost = new Float64Array(V); bestCost.fill(Infinity);
    const heap = []; jqHeapPush(heap, [0, source, 0, 0, -1, -1]); bestCost[source] = 0;
    let popped = 0, best = null;
    while (heap.length && popped < JQ_SEARCH_LIMIT) {
      const node = jqHeapPop(heap); const [cost, i, steps, loss, first, direction] = node;
      if (cost !== bestCost[i]) continue;
      popped++;
      if (steps > 0) {
        const score = endpointScore(source, i, steps, loss, first, capacity);
        if (score > 0.01 && (!best || score > best.score)) best = { score, source, target: i, next: first, direction, half: movement.half, count: movement.count };
        if (owner[i] === -2) continue;
        if (terrain[i] === 3 && enemy(owner[i])) continue;
      }
      if (steps >= 28) continue;
      for (let k = 0; k < 4; k++) {
        const d = (k + rotation) & 3, j = neighbor(i, d);
        if (j < 0 || terrain[j] === 1 || blocked[j]) continue;
        if (owner[j] !== me && allied(rememberedOwner(j))) continue;
        const friendly = owner[j] === me, nextLoss = loss + 1 + (friendly ? 0 : defense(j));
        if (capacity - nextLoss < 1) continue;
        const nextSteps = steps + 1, nextCost = nextSteps + 0.18 * (nextLoss - nextSteps);
        if (nextCost >= bestCost[j]) continue;
        bestCost[j] = nextCost;
        jqHeapPush(heap, [nextCost, j, nextSteps, nextLoss, steps === 0 ? j : first, steps === 0 ? d : direction]);
      }
    }
    return best;
  }
  for (let slot = 0; slot < 4; slot++) {
    const candidates = [], homeNeed = (homeReserve > 1 ? Math.max(0, homeReserve + g - army[general]) : 0);
    for (let i = 0; i < V; i++) {
      if (blocked[i]) continue; const movement = movable(i); if (!movement) continue;
      const fd = frontierDistance[i] < 0 ? 30 : frontierDistance[i];
      let rank = movement.count / (1 + 0.055 * fd); const hd = homeDistance[i];
      if (i !== general && homeNeed > 0 && hd > 0) rank += Math.min(homeNeed, movement.count) * 3 / hd;
      candidates.push({ i, movement, rank });
    }
    candidates.sort((a, b) => b.rank - a.rank || a.i - b.i); let choice = null;
    for (let k = 0; k < Math.min(JQ_SOURCE_LIMIT, candidates.length); k++) {
      const c = candidates[k], result = search(c.i, c.movement);
      if (result && (!choice || result.score > choice.score)) choice = result;
    }
    if (!choice) break;
    const s = choice.source, d = choice.next, sent = choice.count;
    moves.push({ from: { x: s % W, y: Math.floor(s / W) }, dir: JQ_DIRS[choice.direction], half: choice.half });
    selectedGoal = choice.target; lastFrom = s; lastTo = d; army[s] -= sent;
    if (owner[d] === me) army[d] += sent;
    else if (owner[d] === -2) blocked[d] = 1;
    else {
      const previousOwner = owner[d];
      if (sent <= army[d]) army[d] -= sent;
      else { army[d] = sent - army[d]; owner[d] = me; if (terrain[d] === 3 && enemy(previousOwner)) break; }
    }
  }
  const records = Array.from(sightings.values());
  function recordPriority(r) {
    const i = r[0]; let priority = terrain[i] === 3 ? 100000 : terrain[i] === 2 ? 50000 : 0;
    if (enemy(r[1])) priority += 10000;
    priority += Math.min(5000, r[2]); priority -= Math.min(1000, tick - r[3]) * 4; return priority;
  }
  records.sort((a, b) => recordPriority(b) - recordPriority(a) || a[0] - b[0]);
  return { moves, memory: { v: 1, key, tick, seen: records.slice(0, JQ_MEMORY_LIMIT), from: lastFrom, to: lastTo, goal: selectedGoal } };
}
