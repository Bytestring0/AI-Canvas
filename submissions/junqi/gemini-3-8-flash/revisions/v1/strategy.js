// strategy.js
// 将军棋 (junqi-2 协议) 高性能智能策略
// 具备：迷雾记忆、多步连续突进 (Blitz)、智能集结、紧急本阵防守、精准城市夺取与闪电斩首

function decide(o) {
  var width = o.width;
  var height = o.height;
  var myId = o.you.id;
  var myGen = o.you.general;
  var size = width * height;

  // 1. 确定性轻量级伪随机数生成器 (基于地图 seed 和当前 tick)
  var rngState = 0;
  for (var si = 0; si < o.seed.length; si++) {
    rngState = (rngState * 31 + o.seed.charCodeAt(si)) | 0;
  }
  rngState = (rngState ^ (o.tick * 0x9e3779b9)) >>> 0;
  function randInt(max) {
    if (max <= 1) return 0;
    rngState = (rngState ^ (rngState << 13)) >>> 0;
    rngState = (rngState ^ (rngState >>> 17)) >>> 0;
    rngState = (rngState ^ (rngState << 5)) >>> 0;
    return (rngState >>> 0) % max;
  }

  // 2. 状态记忆还原与持久化感知
  var mem = o.memory;
  if (!mem || typeof mem !== 'object') {
    mem = {
      knownGenerals: [], // [{x, y, id}]
      targetGen: null,   // {x, y}
      rushCity: null,    // {x, y}
      mode: 'expand'     // 'expand' | 'snipe' | 'city' | 'gather'
    };
  }

  // 坐标辅助函数
  function toIdx(x, y) { return y * width + x; }
  function toX(idx) { return idx % width; }
  function toY(idx) { return Math.floor(idx / width); }
  function inBounds(x, y) { return x >= 0 && x < width && y >= 0 && y < height; }

  var DIRS = [
    { name: 'up', dx: 0, dy: -1 },
    { name: 'right', dx: 1, dy: 0 },
    { name: 'down', dx: 0, dy: 1 },
    { name: 'left', dx: -1, dy: 0 }
  ];

  // 3. 构建当前工作地图（支持 tick 内多指令仿真更新）
  var curArmy = new Int32Array(size);
  var curOwner = new Int8Array(size);
  var knownTerrain = new Int8Array(size);

  var totalMyArmy = 0;
  var totalMyLand = 0;
  var enemyGenerals = [];
  var visibleEnemies = [];
  var candidateCities = [];

  // 合并已记住的敌方将军
  if (Array.isArray(mem.knownGenerals)) {
    for (var gi = 0; gi < mem.knownGenerals.length; gi++) {
      var kg = mem.knownGenerals[gi];
      if (kg && inBounds(kg.x, kg.y)) {
        enemyGenerals.push({ x: kg.x, y: kg.y, id: kg.id });
      }
    }
  }

  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var idx = toIdx(x, y);
      var terr = o.terrain[y][x];
      var own = o.owner[y][x];
      var arm = o.army[y][x];

      knownTerrain[idx] = terr;
      curOwner[idx] = own;
      curArmy[idx] = arm >= 0 ? arm : 0;

      if (own === myId) {
        totalMyArmy += curArmy[idx];
        totalMyLand++;
      } else if (own >= 0) {
        // 可见敌军
        visibleEnemies.push({ x: x, y: y, army: curArmy[idx], owner: own });
      }

      // 敌方将军识别
      if (terr === 3 && (own !== myId || (x !== myGen.x || y !== myGen.y))) {
        var found = false;
        for (var k = 0; k < enemyGenerals.length; k++) {
          if (enemyGenerals[k].x === x && enemyGenerals[k].y === y) {
            found = true;
            break;
          }
        }
        if (!found) {
          enemyGenerals.push({ x: x, y: y, id: own >= 0 ? own : -1 });
        }
      }

      // 城市识别
      if (terr === 2 && own !== myId) {
        candidateCities.push({ x: x, y: y, army: arm >= 0 ? arm : 45 });
      }
    }
  }

  // 同步敌方将军记忆
  mem.knownGenerals = enemyGenerals.slice(0, 16);

  // 4. 指令执行模拟器（最多产生 4 条有效 move）
  var generatedMoves = [];

  function simulateMove(fx, fy, dirName, half) {
    if (generatedMoves.length >= 4) return false;
    var d = null;
    for (var i = 0; i < DIRS.length; i++) {
      if (DIRS[i].name === dirName) { d = DIRS[i]; break; }
    }
    if (!d) return false;

    var tx = fx + d.dx;
    var ty = fy + d.dy;
    if (!inBounds(tx, ty)) return false;

    var fIdx = toIdx(fx, fy);
    var tIdx = toIdx(tx, ty);

    if (knownTerrain[tIdx] === 1) return false; // 山地不可通行
    if (curOwner[fIdx] !== myId || curArmy[fIdx] < 2) return false;

    var n = curArmy[fIdx];
    var k = half ? Math.floor(n / 2) : (n - 1);
    if (k < 1) return false;

    // 提交移动
    generatedMoves.push({
      from: { x: fx, y: fy },
      dir: dirName,
      half: half === true
    });

    // 内部状态同步
    curArmy[fIdx] -= k;
    if (curOwner[tIdx] === myId) {
      curArmy[tIdx] += k;
    } else {
      var defArmy = curArmy[tIdx];
      if (k > defArmy) {
        curOwner[tIdx] = myId;
        curArmy[tIdx] = k - defArmy;
      } else {
        curArmy[tIdx] = defArmy - k;
      }
    }
    return true;
  }

  // 5. 广度优先搜索 (BFS) 与最短路径算法
  var distBuf = new Int32Array(size);
  var parentBuf = new Int32Array(size);
  var queueBuf = new Int32Array(size);

  function bfsDistanceToTarget(targetX, targetY) {
    distBuf.fill(-1);
    var head = 0, tail = 0;
    var startIdx = toIdx(targetX, targetY);
    distBuf[startIdx] = 0;
    queueBuf[tail++] = startIdx;

    while (head < tail) {
      var curr = queueBuf[head++];
      var cx = toX(curr);
      var cy = toY(curr);
      var cd = distBuf[curr];

      for (var i = 0; i < 4; i++) {
        var nx = cx + DIRS[i].dx;
        var ny = cy + DIRS[i].dy;
        if (!inBounds(nx, ny)) continue;
        var nIdx = toIdx(nx, ny);
        if (knownTerrain[nIdx] === 1) continue; // 山地绕行
        if (distBuf[nIdx] === -1) {
          distBuf[nIdx] = cd + 1;
          queueBuf[tail++] = nIdx;
        }
      }
    }
  }

  // 寻找从 (sx, sy) 到目标格 (tx, ty) 的可行攻击路径
  function findPathTo(sx, sy, tx, ty) {
    distBuf.fill(-1);
    parentBuf.fill(-1);
    var head = 0, tail = 0;
    var sIdx = toIdx(sx, sy);
    var tIdx = toIdx(tx, ty);

    distBuf[sIdx] = 0;
    queueBuf[tail++] = sIdx;

    var found = false;
    while (head < tail) {
      var curr = queueBuf[head++];
      if (curr === tIdx) {
        found = true;
        break;
      }
      var cx = toX(curr);
      var cy = toY(curr);

      for (var i = 0; i < 4; i++) {
        var nx = cx + DIRS[i].dx;
        var ny = cy + DIRS[i].dy;
        if (!inBounds(nx, ny)) continue;
        var nIdx = toIdx(nx, ny);
        if (knownTerrain[nIdx] === 1) continue;
        if (distBuf[nIdx] === -1) {
          distBuf[nIdx] = distBuf[curr] + 1;
          parentBuf[nIdx] = curr;
          queueBuf[tail++] = nIdx;
        }
      }
    }

    if (!found) return null;

    var path = [];
    var p = tIdx;
    while (p !== sIdx) {
      path.push(p);
      p = parentBuf[p];
    }
    path.reverse();
    return path; // [nextStep, ..., target]
  }

  // 6. 核心战术决策：
  // 战术 A：紧急本阵防御 (General Defense)
  // 如果有敌军距离我方将军 <= 5 格，且兵力对将军有潜在威胁，优先调动防御
  var imminentThreat = null;
  var minThreatDist = 999;
  for (var vi = 0; vi < visibleEnemies.length; vi++) {
    var ve = visibleEnemies[vi];
    var mDist = Math.abs(ve.x - myGen.x) + Math.abs(ve.y - myGen.y);
    if (mDist <= 6 && mDist < minThreatDist) {
      minThreatDist = mDist;
      imminentThreat = ve;
    }
  }

  if (imminentThreat && imminentThreat.army > 1) {
    // 紧急防御：若将军有兵，且敌人在将军相邻格，直接迎头痛击
    var gIdx = toIdx(myGen.x, myGen.y);
    for (var di = 0; di < 4; di++) {
      var gx = myGen.x + DIRS[di].dx;
      var gy = myGen.y + DIRS[di].dy;
      if (gx === imminentThreat.x && gy === imminentThreat.y) {
        if (curArmy[gIdx] > imminentThreat.army) {
          simulateMove(myGen.x, myGen.y, DIRS[di].name, false);
        }
      }
    }
    // 寻找离威胁最近的大军力格子前往阻截
    if (generatedMoves.length < 4) {
      bfsDistanceToTarget(imminentThreat.x, imminentThreat.y);
      var bestDefender = -1;
      var maxDefArmy = 2;
      for (var idx = 0; idx < size; idx++) {
        if (curOwner[idx] === myId && curArmy[idx] >= maxDefArmy && distBuf[idx] > 0) {
          if (bestDefender === -1 || curArmy[idx] > maxDefArmy || (curArmy[idx] === maxDefArmy && distBuf[idx] < distBuf[bestDefender])) {
            bestDefender = idx;
            maxDefArmy = curArmy[idx];
          }
        }
      }
      if (bestDefender !== -1) {
        var bx = toX(bestDefender);
        var by = toY(bestDefender);
        var defPath = findPathTo(bx, by, imminentThreat.x, imminentThreat.y);
        if (defPath && defPath.length > 0) {
          var stepIdx = defPath[0];
          var stepX = toX(stepIdx);
          var stepY = toY(stepIdx);
          for (var i = 0; i < 4; i++) {
            if (bx + DIRS[i].dx === stepX && by + DIRS[i].dy === stepY) {
              simulateMove(bx, by, DIRS[i].name, false);
              break;
            }
          }
        }
      }
    }
  }

  // 战术 B：闪电斩首行动 (Snipe Enemy General)
  // 若已知敌方将军，且主力部队有能力直捣黄龙，执行单 tick 连续闪击
  if (enemyGenerals.length > 0 && generatedMoves.length < 4) {
    var targetGen = enemyGenerals[0];
    bfsDistanceToTarget(targetGen.x, targetGen.y);

    // 寻找离敌将最近或拥有最庞大兵力能击穿防线的主力
    var bestAttacker = -1;
    var maxPower = 0;
    for (var i = 0; i < size; i++) {
      if (curOwner[i] === myId && curArmy[i] >= 6) {
        var d = distBuf[i];
        if (d > 0) {
          var score = curArmy[i] * 2 - d * 3;
          if (score > maxPower) {
            maxPower = score;
            bestAttacker = i;
          }
        }
      }
    }

    if (bestAttacker !== -1) {
      var ax = toX(bestAttacker);
      var ay = toY(bestAttacker);
      var snipePath = findPathTo(ax, ay, targetGen.x, targetGen.y);
      if (snipePath && snipePath.length > 0) {
        // 进行连突操作 (Blitz: 单 tick 最多向前连推多格)
        var curX = ax;
        var curY = ay;
        for (var pi = 0; pi < snipePath.length && generatedMoves.length < 4; pi++) {
          var nextIdx = snipePath[pi];
          var nx = toX(nextIdx);
          var ny = toY(nextIdx);
          var foundDir = null;
          for (var di = 0; di < 4; di++) {
            if (curX + DIRS[di].dx === nx && curY + DIRS[di].dy === ny) {
              foundDir = DIRS[di].name;
              break;
            }
          }
          if (foundDir) {
            var moved = simulateMove(curX, curY, foundDir, false);
            if (moved && curOwner[nextIdx] === myId) {
              curX = nx;
              curY = ny;
            } else {
              break;
            }
          } else {
            break;
          }
        }
      }
    }
  }

  // 战术 C：城市夺取 (Conquest of Neutral / Enemy Cities)
  // 拥有 45+ 兵力且周围有城市时，迅速拔城，获取每 tick +g 的永久增兵引擎
  if (candidateCities.length > 0 && generatedMoves.length < 4) {
    for (var ci = 0; ci < candidateCities.length && generatedMoves.length < 4; ci++) {
      var targetCity = candidateCities[ci];
      var cityReq = targetCity.army + 2;

      // 寻找附近主力
      var cityHero = -1;
      for (var idx = 0; idx < size; idx++) {
        if (curOwner[idx] === myId && curArmy[idx] >= cityReq) {
          var dist = Math.abs(toX(idx) - targetCity.x) + Math.abs(toY(idx) - targetCity.y);
          if (dist <= 8) {
            cityHero = idx;
            break;
          }
        }
      }

      if (cityHero !== -1) {
        var hx = toX(cityHero);
        var hy = toY(cityHero);
        var cityPath = findPathTo(hx, hy, targetCity.x, targetCity.y);
        if (cityPath && cityPath.length > 0) {
          var cCurX = hx;
          var cCurY = hy;
          for (var cpi = 0; cpi < cityPath.length && generatedMoves.length < 4; cpi++) {
            var cNextIdx = cityPath[cpi];
            var cnx = toX(cNextIdx);
            var cny = toY(cNextIdx);
            var cDir = null;
            for (var d = 0; d < 4; d++) {
              if (cCurX + DIRS[d].dx === cnx && cCurY + DIRS[d].dy === cny) {
                cDir = DIRS[d].name;
                break;
              }
            }
            if (cDir) {
              var ok = simulateMove(cCurX, cCurY, cDir, false);
              if (ok && curOwner[cNextIdx] === myId) {
                cCurX = cnx;
                cCurY = cny;
              } else {
                break;
              }
            } else {
              break;
            }
          }
        }
      }
    }
  }

  // 战术 D：早期快速圈地开拓与前线兵力输送 (Early Expansion & Frontline Funneling)
  // 如果剩余 move 配额仍未用完，调度高兵力格子（包括将军积累的产出）开拓未知领土或占领邻接空地
  var guardGenArmy = (o.tick < 80) ? 1 : 4;

  while (generatedMoves.length < 4) {
    // 寻找当前全图拥有 >= 2 军队且最具开拓价值的我方格子
    var bestFrom = -1;
    var bestScore = -999999;
    var chosenDir = null;

    for (var idx = 0; idx < size; idx++) {
      if (curOwner[idx] !== myId) continue;
      var army = curArmy[idx];
      var fx = toX(idx);
      var fy = toY(idx);

      // 将军保底守军判断
      if (fx === myGen.x && fy === myGen.y && army <= guardGenArmy) {
        continue;
      }
      if (army < 2) continue;

      // 评估四个方向
      for (var di = 0; di < 4; di++) {
        var d = DIRS[di];
        var nx = fx + d.dx;
        var ny = fy + d.dy;
        if (!inBounds(nx, ny)) continue;
        var nIdx = toIdx(nx, ny);
        var terr = knownTerrain[nIdx];
        if (terr === 1) continue; // 山地不可走

        var targetOwner = curOwner[nIdx];
        var targetArmy = curArmy[nIdx];

        // 避免盲目撞中立城（若吃不下）
        if (terr === 2 && targetOwner !== myId && army - 1 <= targetArmy) {
          continue;
        }

        var score = 0;
        if (targetOwner !== myId) {
          // 攻占未占领/敌方领地
          if (army - 1 > targetArmy) {
            // 能够直接吃下
            score = 1000 + army * 10 - targetArmy * 5;
            if (targetOwner >= 0) score += 500; // 杀敌占地优先
            if (terr === 0) score += 200;       // 平地扩张
          } else {
            // 吃不下敌方
            score = -500;
          }
        } else {
          // 移动向己方格子（集结 / 输送）
          // 鼓励向远离将军、更靠前线的方向输送
          var myGenDistCurr = Math.abs(fx - myGen.x) + Math.abs(fy - myGen.y);
          var myGenDistNext = Math.abs(nx - myGen.x) + Math.abs(ny - myGen.y);
          score = (myGenDistNext - myGenDistCurr) * 40 + army;
        }

        // 加入少量确定性微扰，打破对称性与走位锁死
        score += randInt(7);

        if (score > bestScore) {
          bestScore = score;
          bestFrom = idx;
          chosenDir = d.name;
        }
      }
    }

    if (bestFrom !== -1 && chosenDir) {
      var bx = toX(bestFrom);
      var by = toY(bestFrom);
      var moved = simulateMove(bx, by, chosenDir, false);
      if (!moved) break;
    } else {
      break;
    }
  }

  // 保证合法性兜底：最多 4 条指令
  var finalMoves = generatedMoves.slice(0, 4);

  return {
    moves: finalMoves,
    memory: mem
  };
}