// strategy.js
// junqi-2：确定性的扩张、经济集结、搜将与将军防守策略。

function JunqiHeap() {
  this.keys = [];
  this.nodes = [];
}
JunqiHeap.prototype.push = function (key, node) {
  const keys = this.keys, nodes = this.nodes;
  let i = keys.length;
  keys.push(key);
  nodes.push(node);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (keys[p] < key || (keys[p] === key && nodes[p] <= node)) break;
    keys[i] = keys[p];
    nodes[i] = nodes[p];
    i = p;
  }
  keys[i] = key;
  nodes[i] = node;
};
JunqiHeap.prototype.pop = function () {
  const keys = this.keys, nodes = this.nodes;
  if (keys.length === 0) return null;
  const result = [keys[0], nodes[0]];
  const key = keys.pop(), node = nodes.pop();
  if (keys.length) {
    let i = 0;
    while (true) {
      let c = i * 2 + 1;
      if (c >= keys.length) break;
      if (c + 1 < keys.length &&
          (keys[c + 1] < keys[c] ||
           (keys[c + 1] === keys[c] && nodes[c + 1] < nodes[c]))) {
        c++;
      }
      if (keys[c] > key || (keys[c] === key && nodes[c] >= node)) break;
      keys[i] = keys[c];
      nodes[i] = nodes[c];
      i = c;
    }
    keys[i] = key;
    nodes[i] = node;
  }
  return result;
};

function junqiHash(value) {
  const s = String(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function decide(observation) {
  const o = observation;
  if (!o.you.alive) return { moves: [], memory: null };

  const W = o.width, H = o.height, N = W * H;
  const me = o.you.id, tick = o.tick;
  const home = o.you.general.y * W + o.you.general.x;
  const growth = 1 + Math.floor(tick / 200);
  const remaining = Math.max(0, o.maxTicks - tick);
  const seedHash = junqiHash(o.seed);
  const directions = ["up", "right", "down", "left"];
  const teams = new Map(), alive = new Map();
  for (const p of o.players) {
    teams.set(p.id, p.team);
    alive.set(p.id, p.alive);
  }
  function ally(id) {
    return id >= 0 && teams.get(id) === o.you.team;
  }
  function enemy(id) {
    return id >= 0 && teams.has(id) && !ally(id);
  }

  const terrain = new Int8Array(N);
  const owner = new Int32Array(N);
  const army = new Float64Array(N);
  const visible = new Uint8Array(N);
  const ownInitially = new Uint8Array(N);
  const neighbors = new Int32Array(N * 4);
  neighbors.fill(-1);

  const own = [];
  let maxStack = 1, mobileTotal = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      terrain[i] = o.terrain[y][x];
      owner[i] = o.owner[y][x];
      army[i] = o.army[y][x];
      visible[i] = owner[i] !== -2 ? 1 : 0;
      if (owner[i] === me) {
        ownInitially[i] = 1;
        own.push(i);
        maxStack = Math.max(maxStack, army[i]);
        mobileTotal += Math.max(0, army[i] - 1);
      }
    }
  }
  if (own.length === 0) return { moves: [], memory: null };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (terrain[i] === 1) continue;
      const b = i * 4;
      if (y > 0 && terrain[i - W] !== 1) neighbors[b] = i - W;
      if (x + 1 < W && terrain[i + 1] !== 1) neighbors[b + 1] = i + 1;
      if (y + 1 < H && terrain[i + W] !== 1) neighbors[b + 2] = i + W;
      if (x > 0 && terrain[i - 1] !== 1) neighbors[b + 3] = i - 1;
    }
  }

  const old = o.memory;
  const validMemory = old && old.v === 2 && old.s === seedHash &&
    old.w === W && old.h === H && old.me === me &&
    Number.isInteger(old.t) && old.t < tick;

  const records = new Map();
  const generals = new Map();
  const history = [];

  if (validMemory) {
    if (Array.isArray(old.r)) {
      for (const r of old.r.slice(0, 160)) {
        if (Array.isArray(r) && r.length === 4 &&
            Number.isInteger(r[0]) && r[0] >= 0 && r[0] < N &&
            Number.isInteger(r[1]) && r[1] >= -1 &&
            r[1] < o.playerCount &&
            Number.isFinite(r[2]) && r[2] >= 0 &&
            Number.isInteger(r[3]) && r[3] >= 0 && r[3] <= tick) {
          records.set(r[0], r);
        }
      }
    }
    if (Array.isArray(old.g)) {
      for (const r of old.g.slice(0, 16)) {
        if (Array.isArray(r) && r.length === 2 &&
            Number.isInteger(r[0]) && r[0] >= 0 && r[0] < N &&
            Number.isInteger(r[1]) && enemy(r[1]) && alive.get(r[1])) {
          generals.set(r[0], r[1]);
        }
      }
    }
    if (Array.isArray(old.e)) {
      for (const e of old.e.slice(-16)) {
        if (Array.isArray(e) && e.length === 3 &&
            e.every(Number.isInteger) &&
            e[0] >= 0 && e[0] < N && e[1] >= 0 && e[1] < N &&
            e[2] <= tick && e[2] >= tick - 6) {
          history.push(e);
        }
      }
    }
  }

  for (let i = 0; i < N; i++) {
    if (!visible[i]) continue;
    records.delete(i);
    if (owner[i] !== me &&
        (terrain[i] === 2 || terrain[i] === 3 ||
         (enemy(owner[i]) && army[i] > 1))) {
      records.set(i, [i, owner[i], Math.max(0, army[i]), tick]);
    }
    if (terrain[i] === 3 && enemy(owner[i]) && alive.get(owner[i])) {
      generals.set(i, owner[i]);
    } else {
      generals.delete(i);
    }
  }
  for (const [i, id] of generals) {
    if (!alive.get(id) || terrain[i] !== 3) generals.delete(i);
  }

  // 估计只用于选路和目标排序，当前可见数据始终优先。
  function estimatedOwner(i) {
    if (visible[i]) return owner[i];
    const gid = generals.get(i);
    if (gid !== undefined) return gid;
    const r = records.get(i);
    if (!r) return -2;
    if (r[1] >= 0 && !alive.get(r[1])) return -2;
    return r[1];
  }
  function defenders(i) {
    if (visible[i]) return Math.max(0, army[i]);
    const r = records.get(i);
    if (r) {
      if (r[1] === -1) return r[2];
      if (r[1] >= 0 && !alive.get(r[1])) {
        return terrain[i] === 2 ? 50 : 0;
      }
      const age = tick - r[3];
      if (terrain[i] === 2 || terrain[i] === 3) {
        return Math.min(10000, r[2] + age * growth);
      }
      if (age <= 35) {
        return Math.ceil(r[2] * (1 - age / 45)) +
          Math.ceil(age / 25) * growth;
      }
    }
    if (terrain[i] === 2) return 50;
    if (terrain[i] === 3 && generals.has(i)) return 15 + growth * 8;
    return 0;
  }

  const queue = new Int32Array(N);
  function bfs(sources) {
    const dist = new Int32Array(N);
    dist.fill(-1);
    let head = 0, tail = 0;
    for (const s of sources) {
      if (s >= 0 && s < N && dist[s] < 0 && terrain[s] !== 1) {
        dist[s] = 0;
        queue[tail++] = s;
      }
    }
    while (head < tail) {
      const i = queue[head++];
      for (let d = 0; d < 4; d++) {
        const j = neighbors[i * 4 + d];
        if (j >= 0 && dist[j] < 0) {
          dist[j] = dist[i] + 1;
          queue[tail++] = j;
        }
      }
    }
    return dist;
  }

  const fromHome = bfs([home]);
  const fromOwn = bfs(own);

  let immediateThreat = 0, approachingThreat = 0;
  for (let i = 0; i < N; i++) {
    if (!visible[i] || !enemy(owner[i]) || army[i] < 2) continue;
    const d = fromHome[i];
    if (d >= 1 && d <= 4) immediateThreat += army[i] - 1;
    else if (d > 4 && d <= 8) {
      approachingThreat = Math.max(
        approachingThreat,
        Math.max(0, army[i] - 1 - (d - 4) * growth) * 0.65
      );
    }
  }
  const homeReserve = Math.max(
    1,
    Math.ceil(immediateThreat + 1),
    Math.ceil(approachingThreat)
  );

  // 选一个经济或斩首目标，其他军队仍可执行局部战术。
  let goal = -1, goalKind = "", goalValue = -Infinity, goalDefense = 0;
  const previousGoal = validMemory && Number.isInteger(old.q) ? old.q : -1;

  for (let i = 0; i < N; i++) {
    if (terrain[i] !== 2 && terrain[i] !== 3) continue;
    const id = estimatedOwner(i);
    if (id === me || ally(id)) continue;
    const d = fromOwn[i];
    if (d < 0) continue;
    const def = defenders(i);
    const isGeneral = generals.has(i) && enemy(id) && alive.get(id);
    const isCity = terrain[i] === 2;
    if (!isGeneral && !isCity) continue;

    let value;
    if (isGeneral) {
      const readiness = Math.min(1.4, (maxStack + mobileTotal * 0.12) /
        Math.max(8, def + d + 4));
      value = 22 * (0.35 + readiness) / (1 + d * 0.065);
    } else {
      // 用当前产量计算保守回本窗口，不预支未来产量提升。
      if (remaining <= def / growth + d / 4 + 15) continue;
      const readiness = Math.min(1.3,
        (maxStack + mobileTotal * 0.22 + 8) / (def + d + 5));
      value = (8 + readiness * 8) / (1 + d * 0.11);
      if (enemy(id)) value *= 1.12;
      if (id === -2) value *= 0.82;
    }
    if (i === previousGoal) value *= 1.16;
    if (value > goalValue ||
        (value === goalValue && (goal < 0 || i < goal))) {
      goal = i;
      goalKind = isGeneral ? "general" : "city";
      goalValue = value;
      goalDefense = def;
    }
  }

  const goalDistance = new Float64Array(N);
  goalDistance.fill(Infinity);
  const goalNext = new Int32Array(N);
  goalNext.fill(-1);
  const goalSteps = new Int32Array(N);
  goalSteps.fill(-1);

  if (goal >= 0) {
    const heap = new JunqiHeap();
    const scale = Math.max(10, maxStack * 0.22);
    goalDistance[goal] = 0;
    goalSteps[goal] = 0;
    heap.push(0, goal);
    while (heap.keys.length) {
      const item = heap.pop(), cost = item[0], i = item[1];
      if (cost !== goalDistance[i]) continue;
      const id = estimatedOwner(i);
      const resistance = id === me ? 0 : defenders(i);
      const stepCost = 1 + resistance / scale +
        (terrain[i] === -1 ? 0.7 : 0) +
        (!visible[i] && terrain[i] !== -1 ? 0.2 : 0);
      for (let d = 0; d < 4; d++) {
        const j = neighbors[i * 4 + d];
        if (j < 0) continue;
        const jid = estimatedOwner(j);
        // 队友格可增援，但不能作为己方连续行军的中间节点。
        if (jid !== me && ally(jid)) continue;
        const nextCost = cost + stepCost;
        if (nextCost < goalDistance[j]) {
          goalDistance[j] = nextCost;
          goalNext[j] = i;
          goalSteps[j] = goalSteps[i] + 1;
          heap.push(nextCost, j);
        }
      }
    }
  }

  function scoutingValue(i) {
    const x = i % W, y = Math.floor(i / W);
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H &&
            terrain[yy * W + xx] === -1) count++;
      }
    }
    return count;
  }

  // 从可扩张边界向己方内部传播吸引力，动员分散的闲置兵。
  const frontierValue = new Float64Array(N);
  const frontierNext = new Int32Array(N);
  frontierNext.fill(-1);
  const frontierHeap = new JunqiHeap();

  for (const i of own) {
    for (let d = 0; d < 4; d++) {
      const j = neighbors[i * 4 + d];
      if (j < 0 || terrain[j] === -1 || owner[j] === me || ally(owner[j])) {
        continue;
      }
      const def = defenders(j);
      if ((terrain[j] === 2 || terrain[j] === 3) && def > 8) continue;
      if (def > Math.max(8, maxStack * 0.65)) continue;
      const value = Math.max(
        2,
        16 + scoutingValue(j) * 1.2 + (enemy(owner[j]) ? 4 : 0) -
          def * 0.7
      );
      if (value > frontierValue[i]) {
        frontierValue[i] = value;
        frontierNext[i] = j;
      }
    }
    if (frontierValue[i] > 0) frontierHeap.push(-frontierValue[i], i);
  }

  while (frontierHeap.keys.length) {
    const item = frontierHeap.pop(), value = -item[0], i = item[1];
    if (value !== frontierValue[i]) continue;
    const propagated = value * 0.86;
    if (propagated < 0.5) continue;
    for (let d = 0; d < 4; d++) {
      const j = neighbors[i * 4 + d];
      if (j >= 0 && owner[j] === me && propagated > frontierValue[j] + 1e-9) {
        frontierValue[j] = propagated;
        frontierNext[j] = i;
        frontierHeap.push(-propagated, j);
      }
    }
  }

  const moves = [];
  const sources = own.slice();
  const sourceKnown = new Uint8Array(N);
  for (const i of sources) sourceKnown[i] = 1;
  const retiredEnemies = new Set();

  function reversalPenalty(a, b) {
    for (let k = history.length - 1; k >= 0; k--) {
      const e = history[k];
      if (e[0] === b && e[1] === a && tick - e[2] <= 4) return 14;
    }
    return 0;
  }

  for (let action = 0; action < 4; action++) {
    let best = null, bestScore = 0.5;
    let defenseNeed = Math.max(0, homeReserve - Math.max(0, army[home]));

    for (const i of sources) {
      // 对原观察视野外的盲攻不继续假设成功后连走。
      if (owner[i] !== me || army[i] < 2 || !visible[i]) continue;
      const n = army[i];

      for (let d = 0; d < 4; d++) {
        const j = neighbors[i * 4 + d];
        if (j < 0 || terrain[j] === -1) continue;
        const targetOwner = owner[j];
        if (targetOwner !== me && ally(targetOwner)) continue;

        for (let variant = 0; variant < 2; variant++) {
          const half = variant === 1;
          const sent = half ? Math.floor(n / 2) : n - 1;
          if (sent < 1 || (half && sent === n - 1)) continue;
          const left = n - sent;
          if (i === home && left < homeReserve) continue;

          const friendly = targetOwner === me;
          const def = friendly ? 0 : defenders(j);
          const targetIsEnemy = enemy(targetOwner);
          const kill = !friendly && terrain[j] === 3 &&
            targetIsEnemy && !retiredEnemies.has(targetOwner);

          let margin = 0;
          if (targetIsEnemy && (terrain[j] === 2 || terrain[j] === 3)) {
            margin = growth;
          }
          if (!friendly && sent <= def + margin) continue;

          let score = -Infinity;
          const helpsDefense = friendly && defenseNeed > 0 &&
            fromHome[i] > 0 && fromHome[j] >= 0 &&
            fromHome[j] < fromHome[i];

          if (friendly) {
            if (helpsDefense) {
              const distance = fromHome[i];
              score = (immediateThreat > 0 ? 180 : 80) +
                Math.min(sent, defenseNeed) * 1.5 - distance * 4;
              if (sent > defenseNeed) score -= (sent - defenseNeed) * 0.05;
            }

            if (frontierNext[i] === j &&
                frontierValue[j] > frontierValue[i]) {
              const expansionScore = 3 + frontierValue[j] * 0.43 +
                Math.min(8, Math.log2(sent + 1));
              score = Math.max(score, expansionScore);
            }

            if (goal >= 0 && goalNext[i] === j) {
              const steps = Math.max(1, goalSteps[i]);
              const base = goalKind === "general" ? 34 : 23;
              let rally = base + Math.min(18, sent * 0.12) -
                Math.min(12, steps * 0.22);
              if (sent === 1) rally -= 12;
              if (remaining < steps / 4 + 5) rally = -Infinity;
              score = Math.max(score, rally);
            }

            // 没有边界指引时，零散兵仍可加入更大的前线兵团。
            if (army[j] >= n * 2 && fromHome[j] >= fromHome[i] &&
                frontierValue[j] > 0) {
              score = Math.max(score, 2 + Math.min(5, sent * 0.1));
            }
          } else {
            const lossPenalty = def * (remaining < 80 ? 0.55 : 0.13);
            score = 13 + scoutingValue(j) * 1.15 +
              Math.min(6, Math.log2(sent + 1)) - lossPenalty;

            if (targetIsEnemy) score += 6;
            if (!visible[j]) score -= 9;
            if (terrain[j] === 2) {
              const payback = remaining * growth - def;
              if (!targetIsEnemy && payback <= 10) continue;
              score += 24 + Math.min(24, Math.max(0, payback) * 0.035);
            }
            if (kill) {
              const victim = o.players.find(p => p.id === targetOwner);
              score += 1000 +
                (victim ? Math.min(500, victim.army * 0.2 + victim.land) : 0);
            }
            if (j === goal) score += goalKind === "general" ? 120 : 22;
            else if (goal >= 0 && goalNext[i] === j) {
              score += goalKind === "general" ? 24 : 10;
            }

            // 拦截将军附近的敌军，优先消除可直接进攻的兵团。
            if (targetIsEnemy && fromHome[j] >= 0 && fromHome[j] <= 4) {
              score += 55 + Math.min(80, def * 1.5);
            }

            // 在目标前建立兵团，避免刚积累的攻城兵反复用于铺地。
            if (goal >= 0 && j !== goal && goalSteps[i] >= 0 &&
                goalSteps[i] <= 2 &&
                n < goalDefense + goalSteps[i] + growth * 2 + 5 &&
                !kill && !(targetIsEnemy && fromHome[j] <= 4)) {
              score -= 35;
            }
          }

          // 生产点分批出兵，给长途集结留下能走完路径的兵量。
          const producing = terrain[i] === 2 || i === home;
          if (producing && !helpsDefense && !kill) {
            const launch = goal >= 0 && goalSteps[i] > 0
              ? Math.min(22, Math.max(5, goalSteps[i] + 4))
              : 3;
            if (n < launch) continue;
          }

          if (!helpsDefense && !kill) score -= reversalPenalty(i, j);
          if (i === home && immediateThreat > 0 && !helpsDefense && !kill) {
            score -= 20;
          }
          if (half) score -= 0.8;

          // 固定种子、tick、坐标打破对称；不使用非确定性时间或随机数。
          const tie = (
            Math.imul(i + 1, 1103515245) ^
            Math.imul(j + 1, 12345) ^
            Math.imul(tick + 1, 2654435761) ^ seedHash
          ) >>> 0;
          score += (tie % 997) * 0.000001;

          if (score > bestScore) {
            bestScore = score;
            best = { i, j, d, half, sent, def, friendly, kill, targetOwner };
          }
        }
      }
    }

    if (!best) break;
    const b = best;
    moves.push({
      from: { x: b.i % W, y: Math.floor(b.i / W) },
      dir: directions[b.d],
      half: b.half
    });
    history.push([b.i, b.j, tick]);

    // 按己方指令顺序模拟，供同 tick 后续决策使用。
    army[b.i] -= b.sent;
    if (b.friendly) {
      army[b.j] += b.sent;
    } else if (visible[b.j]) {
      const survivors = b.sent - b.def;
      if (b.kill) {
        retiredEnemies.add(b.targetOwner);
        for (let k = 0; k < N; k++) {
          if (owner[k] !== b.targetOwner) continue;
          owner[k] = me;
          army[k] = Math.max(1, Math.floor(Math.max(0, army[k]) / 2));
          if (!sourceKnown[k]) {
            sources.push(k);
            sourceKnown[k] = 1;
          }
        }
        // 将军格先接收转让守军，再并入进攻剩余部队。
        army[b.j] += survivors;
        terrain[b.j] = 2;
        generals.delete(b.j);
      } else {
        owner[b.j] = me;
        army[b.j] = survivors;
      }
      if (!sourceKnown[b.j]) {
        sources.push(b.j);
        sourceKnown[b.j] = 1;
      }
      records.delete(b.j);
    } else {
      // 盲攻结果未知，仅扣除已下令出发的军队，不预测新出发点。
      army[b.j] = -1;
    }
  }

  // 输出记忆只保存紧凑的普通数组；不序列化地图、堆或 Infinity。
  const recordList = [];
  for (const [i, r] of records) {
    if (owner[i] === me || retiredEnemies.has(r[1])) continue;
    const age = tick - r[3];
    if (terrain[i] !== 2 && terrain[i] !== 3 && age > 40) continue;
    recordList.push(r);
  }
  recordList.sort(function (a, b) {
    function priority(r) {
      return (terrain[r[0]] === 3 ? 100000 : 0) +
        (terrain[r[0]] === 2 ? 10000 : 0) +
        (fromHome[r[0]] >= 0 && fromHome[r[0]] <= 8 ? 2000 : 0) +
        Math.min(1000, r[2]) - (tick - r[3]) * 10;
    }
    return priority(b) - priority(a) || a[0] - b[0];
  });

  const generalList = [];
  for (const [i, id] of generals) {
    if (!retiredEnemies.has(id)) generalList.push([i, id]);
  }
  generalList.sort((a, b) => a[0] - b[0]);

  return {
    moves,
    memory: {
      v: 2,
      s: seedHash,
      w: W,
      h: H,
      me,
      t: tick,
      q: goal >= 0 && owner[goal] !== me ? goal : -1,
      r: recordList.slice(0, 160),
      g: generalList.slice(0, 16),
      e: history.slice(-16)
    }
  };
}