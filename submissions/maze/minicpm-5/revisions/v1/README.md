迷宫竞速：AI 策略
两名 AI 策略：走迷宫 (strategy.js) 和 追逐 (hunter.js)。每个玩家有两个独立的 Web Worker 在沙箱 iframe 中执行，Worker 位于不透明源 sandbox。CSP 禁止联网，无法访问页面、父窗口和存储。

决定函数：decide(o)，接收当前状态 o（包括角色、内存等），返回 { action, memory }：

strategy.js: 走迷宫策略；返回 {action: string (up/down/right/left), memory: number 或 null}，每次 tick 调一次。
hunter.js: 追逐策略；返回 {actions: Array of [{id, action}], memory: null}，每周期调用 hunter 为所有狩猎者执行一个行动，每个有效 id 恰好出现一次。
运行方式：纯浏览器，无 AI API。每次初始化约 1500ms，decide 最多 200ms，超时终止。

统一输入：两个文件收到相同的结构；role 可不同；内存来源不同；初始状态：角色 runner 或 hunter；player x 0, y 0；start (0,0)，exit (14,5)；grid 21×15；通道 0，墙 1；机关和闸门周期性打开：机关开 4/5，关闭 6-8；钥匙与出口分离；追逐者初始随机。候选角色：runner 或 hunter。

分数计算：

逃生：成功获得 6000，否则 0。
速度：floor(2000 * (1 - finishTick / maxTicks))，否则 0。
晶片：floor(1000 * 已收集晶片数 / 地图晶片总数)。
探索：floor(500 * visited 去重格数 / 地图通道总格数)。
生命：floor(500 * hp / 3)。有效作品至少 6000 分。
策略错误总和为 0。按总分降序；同分按 tick 结束时间早者优先，最后按 id 字符序稳定排序。追逐策略仅用于公平对手抽签，不参与个人计分。

实现细节：

可重赛：相同种子、难度参数、名单顺序、每个世界的初始位置和门状态。
不穿墙：依靠观察中的 grid 和守卫判断。
避免伤害：在关门时不做行动；在机关期间不做行动；追逐者优先获取钥匙和出口。
计时严格：不等待时钟，只由步骤计数控制。
内存：strategy.js 每次返回 {action, memory}， hunter 返回 actions 和 memory；两者独立，但可以通过观察中的 memory 作为下次 turn 参数（注意：hunter 调用时可能因周期不同 turn 变化？题目说：下一次 decide 仍从观察获取 memory。我们可以将 strategy 返回 {turn: memory}；hunter 在 step 时先检查内存是否有效，并决定动作。但保持一致：将 strategy 的 memory 设为下次 decision 时使用的 turn，hunter 在执行 hunter 时使用一个持久内存（如 lastAction），确保下次 decision 基于相同的记忆。