# 迷宫竞速：AI 策略编程任务（完整独立协议 maze-1）

你无法访问仓库、网页、SDK 或其他文件。下面包含全部协议，请直接完成代码，不要索要其他资料。

请交付且仅交付三个完整文件：

1. `strategy.js`：走迷宫策略。
2. `hunter.js`：追逐策略。
3. `README.md`：解释两种算法、状态记忆、复杂度、局限与设计取舍，不虚构实测结果。

回答时用三个带文件名的代码块给出全文。两份 JS 都必须在顶层定义 `function decide(observation) { ... }`；可以增加函数、常量。不要使用 import、export、第三方包或依赖外部文件。可用 TypeScript 设计，但交付必须是编译后的标准 JavaScript，不含类型标注。

## 运行方式与资源

纯现代浏览器，无后端、无 AI API 调用。每个参赛者的两份策略分别在独立 Web Worker 执行，Worker 位于不透明源 sandbox iframe 内，CSP 禁止联网，无法访问页面、父窗口和存储。不得使用网络、DOM、动态模块、importScripts 或额外 Worker。每次初始化最多 1500ms；每次 decide（包含异步等待和消息传递）最多 200ms，超时直接终止。文件各不超过 100000 字节；每次返回值 JSON 序列化后最多 32768 字符，所有数字必须有限，不得使用循环引用、BigInt 或不可序列化状态。推荐同步、快速的算法。

策略可返回 memory（任意 JSON 值），下次调用通过 observation.memory 原样收到；不返回则重置为 null。每局每个 Worker 独立初始化，顶层变量可跨决策保留，但不得依赖 Date、performance、Math.random、crypto 等非确定性输入；需要随机时用 seed、tick 和自建确定性伪随机生成器。同一地图、名单和确定性脚本应可重赛复现。播放速度仅影响展示时间，不能影响决策。玩家与追逐者从未共享 JS 变量或 memory。每个玩家世界里的追逐策略也有独立 memory。

## 地图与公平性

迷宫由种子生成，全部格子公开，没有视野迷雾。`grid[y][x]` 为 0 表示通道，1 表示固定墙；坐标从左上角 (0,0) 开始，x 向右、y 向下。地图边缘为墙。随机生成通道、环路、钥匙、出口、晶片、机关、闸门和追逐者初始位置，不重叠。忽略周期闸门时所有通道互通，闸门周期性开放。钥匙与出口分离。追逐策略可能很强，不保证玩家必胜。

难度固定参数：

| level | 尺寸 | maxTicks | 追逐者数量 | hunterEvery | 机关 | 闸门 | 晶片 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scout | 21×15 | 360 | 1 | 3 | 6 | 4 | 8 |
| standard | 29×21 | 560 | 2 | 3 | 12 | 8 | 12 |
| expert | 35×25 | 800 | 3 | 2 | 20 | 12 | 16 |

每场所有走迷宫策略使用相同地图、3 点初始生命、相同追逐者初始位置、相同规则，各自在独立世界竞赛，玩家之间不相互阻挡。每轮从完整参赛名单（包括明确标注的示例，如果启用）的 `hunter.js`，以及额外内置追逐策略组成的池中，等概率抽取一份代码。这份代码控制本轮所有世界的全部追逐者；它在每个世界可根据对应玩家位置作不同选择。相同种子、难度、名单、额外策略及顺序复现相同抽签。你的追逐策略本轮未被抽到时不会执行；追逐表现不单独加到你的走迷宫分数上。

额外内置追逐策略「我自己写的」不作为玩家参赛：一个追逐者守出口附近，两个各守钥匙和出口，三个中两个守钥匙、一个守出口，守点时在附近往返。玩家拿到钥匙后，全体追逐者转向出口，沿出口朝玩家的通道分点排列，优先选择距出口 1、4、7 格的格子。它遵守相同移动速度、墙体和闸门规则，没有瞬移能力。

## 统一输入

两个文件都收到下面结构，只有 role 与 memory 的来源不同。全部位置坐标为整数；输入是世界的副本，修改它不会直接修改环境。所有字段在每次调用提供，不需要读取文件。

```ts
type Action = 'up' | 'right' | 'down' | 'left' | 'wait';
type Pos = {x: number, y: number};
type Periodic = Pos & {period: number, on: number, phase: number};
interface Observation {
  version: 'maze-1';
  role: 'runner' | 'hunter';
  seed: string;
  tick: number;       // 当前决策 tick，从 0 开始
  maxTicks: number;   // 固定上限
  width: number;
  height: number;
  grid: number[][];   // 完整地图 grid[y][x]
  start: Pos;
  exit: Pos;
  key: Pos | null;   // 玩家拿到钥匙后为 null
  player: Pos & {hp: number, hasKey: boolean, invulnerableUntil: number};
  coins: Pos[];      // 尚未收集的晶片
  gates: (Periodic & {closed: boolean})[];
  traps: (Periodic & {active: boolean})[];
  hunters: (Pos & {id: number})[]; // id 从 0 起，不改变
  hunterEvery: number;
  visited: string[]; // 已走过的通道格，格式 "x,y"，包括起点
  memory: any;       // 此文件上次返回的 JSON memory，首次为 null
}
```

`Periodic` 规则：`(tick + phase) % period < on` 时机关 active 或闸门 closed；否则机关关闭或闸门开放。闸门每周期关闭 2 tick、周期 6–8；机关每周期激活 2 tick、周期 4–6。观察到的布尔值对应当前 tick，在本轮结算期间保持不变。不要根据墙钟等待。

## 输出与有效示例

`strategy.js` 每个 tick 调一次，必须返回 `{action: Action, memory?: JSON}`，例如：

```javascript
function decide(o) {
  const moves = [['right',1,0],['down',0,1],['left',-1,0],['up',0,-1]];
  const prev = o.memory || {turn: 0};
  for (let i=0;i<4;i++) {
    const [action,dx,dy] = moves[(prev.turn+i)%4];
    const x=o.player.x+dx, y=o.player.y+dy;
    if (o.grid[y]?.[x]===0 && !o.gates.some(g=>g.x===x&&g.y===y&&g.closed))
      return {action, memory:{turn:(prev.turn+i+1)%4}};
  }
  return {action:'wait', memory:prev};
}
```

`hunter.js` 仅在 `(tick + 1) % hunterEvery === 0` 时调用一次，必须一次性为所有追逐者返回 `{actions: [{id, action}], memory?: JSON}`。每个有效 id 必须恰好出现一次；不能缺失、重复或增加 id。示例：

```javascript
function decide(o) {
  return {actions:o.hunters.map(h=>({id:h.id, action:'wait'})), memory:null};
}
```

## 精确结算顺序

1. 当前 tick t：玩家和（本 tick 轮到行动时的）追逐者都收到 tick 开始的完整状态，同时决策。追逐者看不到玩家本 tick 的动作或行动后位置。
2. 等所有运行中的世界答复，才统一推进。玩家先按 action 移动一格；撞墙、进关闭闸门均原地不动，wait 原地。不能穿墙、斜行、加速。处在关闭闸门上仍可向外移动。
3. 玩家经过格计入 visited；落在钥匙上永久获得钥匙；落在晶片上永久收集一次。同一晶片不能反复加分。拥有钥匙且落在出口即成功，结束优先于伤害和追逐。
4. 未成功时，如果 `(t+1) % hunterEvery === 0`，所有追逐者按 hunter.js 提供的动作各移一格；受相同墙和关闭闸门阻挡，不受机关伤害、不收集道具，可互相重叠。不行动的 tick 原地不动。
5. 伤害只比较双方行动后的最终格。若玩家所在机关在 t 激活，或与任意追逐者同格，且 `t >= invulnerableUntil`，生命总共扣 1（同一 tick 最多 1）；设置 `invulnerableUntil = t + 3`。此后 t+1、t+2 免伤。擦肩交换位置不造成伤害。
6. 生命归零则 dead；推进到 tick t+1。如果仍未结束且 tick 达 maxTicks，则 timeout。成功、死亡、超时后该世界停止，其他世界继续。finishTick 为结束后的 tick。

玩家脚本异常、非法 action、非法输出或超时：该玩家 status=error、得分 0，不影响其他玩家。追逐脚本异常、非法输出或超时：整轮作废，无有效结算，不给任何玩家授予分数；页面说明原因，可修复后同图重赛。

## 分数与排名

分数为五项之和，最高 10000，各项向下取整；实时排名使用当时已经获得的分数，不预测未来：

- 逃生：成功获得 6000，否则 0。
- 速度：仅成功时 `floor(2000 * (1 - finishTick/maxTicks))`，否则 0。
- 晶片：`floor(1000 * 已收集晶片数 / 地图晶片总数)`。
- 探索：`floor(500 * visited 去重格数 / 地图通道总格数)`。
- 生命：`floor(500 * hp / 3)`。

任何未成功作品最多 2000 分，成功作品至少 6000 分，保证通关优先。策略错误总分为 0。按总分降序；同分时结束 tick 较早者优先（未结束视为正无穷），再比较剩余生命，最后按作品 id 字符序稳定排序。追逐策略归属只用于公平对手抽签，不参与个人走迷宫计分。

请据此编写聪明、快速、可复现的两份策略，并完整解释在 README 中。
