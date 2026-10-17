# AI Canvas

一个可部署到 GitHub Pages、由 GitHub Actions 调度任务的可扩展成果展示框架。框架不调用 AI；模型在外部完成任务后提交文件，由各任务自己的环境运行和展示。

## 给外部 AI 的提示词约定

**外部 AI 默认只能看到操作者复制过去的提示词，看不到仓库、项目文件、运行器源码或网站。** 不应假设它能打开 README、环境配置、模板、SDK 或链接中的协议，也不能让它先索要这些文件才能开始。

每个任务的生成提示词必须可以单独复制使用，正文内完整写明任务目标、交付文件及回答格式、运行环境和资源限制、全部输入输出字段及单位、有效示例、执行规则和异常行为。固定参数直接写入正文；运行时才出现的数据要说明由环境何时、以什么结构提供，不能把生成代码所需的信息留在其他文件里。

操作者使用时应完整复制任务标明的提示词正文；AI 按提示词交付产物，操作者负责保存文件、补提交元数据并上传。复盘提示词也必须连同完整协议、日志及所需旧代码一起提供。不能只说“遵守原协议”或“参照仓库实现”。修改任务协议或环境后，应同步更新提示词，避免文档与实际运行不一致。具体任务的提示词与规则仍保存在各自任务目录内。

## 部署

1. 在 GitHub 新建仓库。使用免费 GitHub Pages 时可先选择公开仓库；私有仓库的 Pages 可用性取决于账号计划。
2. 将本目录的**内容**作为仓库根目录，推送到 `main`，并设为默认分支。仓库顶层应直接看到 `.github/`、`canvas/`、`tasks/` 和 `README.md`，不要额外套一层 `ai-canvas/`。上传时必须包含隐藏目录 `.github`。其他分支名需修改 `.github/workflows/pages.yml`。
3. Settings → Actions → General 中启用 Actions，允许使用工作流中的官方 actions。Workflow permissions 选择 **Read and write permissions**；工作流只有保存结果的 job 请求 contents: write。若组织策略或分支保护禁止机器人推送，需要为结果写回配置相应规则，或下载 artifact 后人工提交。
4. Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。如果尚未选择时第一次部署失败，设置后重新运行即可。
5. Actions → **Check submissions** → **Run workflow**，确认检查通过。该检查与开市时间无关，验证提交、自动测试和静态构建，不实际执行外部策略或验证行情网络。
6. Actions → **Deploy AI Canvas** → **Run workflow**。build、deploy 均为绿色后，进入 Settings → Pages 打开公布的网址，通常是 `https://<用户名>.github.io/<仓库名>/`。此后推送 `main` 自动部署，不需要手工上传 dist/。
7. 需要数据凭据的任务，在自己的 task.json 声明 credential_secret，再按任务 README 添加 Actions Secrets。没有此声明的任务无需配置行情或 AI 密钥。
8. 周期任务要先按其 README 添加有效提交，再通过 **Run scheduled task plugins** → **Run workflow** 测试。手动触发同样遵守任务时间窗；无提交、非运行时段时，plan 成功且后续 job 跳过属于正常情况。定时触发只使用默认分支上的工作流。

**Python 在 GitHub 提供的临时 Ubuntu runner 中运行。** `actions/setup-python` 自动安装运行时，不需要自己部署 Python 服务。Pages 收到的只有构建后的 HTML、CSS、JS、JSON 和作品文件。

运行链路是 `Actions 定时启动 → 获取输入 → 执行任务 → 将 data/ 提交到仓库 → 构建并部署 Pages → 浏览器读取静态结果`。runner 运行完就销毁，仓库中的数据文件负责持久化；无需单独配置数据库。浏览器刷新只读取最新部署的结果，不会直接启动 Python、获取行情或执行任务。纯 HTML 展示任务只需要构建部署。

通用调度工作流每 10 分钟唤醒一次，发现已注册且有提交的任务，再根据各自 task.json 的时区、时间窗与周期派发。任务的 capture 钩子获取输入，run 钩子执行并保存状态；框架将各任务 data/ 目录提交到仓库，再显式调用 Pages 部署更新静态站点。任务脚本、数据获取、状态提交使用不同 job，执行产物的 job 没有数据密钥或仓库写权限。

GitHub cron 可能延迟或丢失触发，框架不承诺严格实时；任务应记录实际时刻并实现幂等。公开仓库长期无活动时，GitHub 可能停用定时工作流。外部调度器也可通过 workflow_dispatch 调用相同流程。

本地通过不代表已经完成云端验收。首次上线还应检查 capture 的外网访问、execute 的运行环境、persist 的提交权限和 publish 的 Pages 部署；具体任务验收条件见任务 README。任务产生的机器人提交不会再次依赖 push 事件部署，调度工作流已显式调用 Pages 工作流发布。

参考：[Pages 静态托管](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[使用 Actions 发布 Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[定时触发的限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

## 目录边界

```text
canvas/                      通用注册、构建、调度与 CLI
web/                         主页、左侧任务导航、模型预览卡片与展开容器
config/models.json           通用模型注册表
schemas/submission.schema.json
submissions/<task>/<model>/  通用提交入口
.github/workflows/           通用部署、检查、任务派发
 tasks/<task-id>/
   task.json                 任务自描述清单
   README.md                 任务目标、提示词、接口与运行环境
   runtime/                  本任务验证、输入采集、执行与构建钩子
   ui/                       本任务展示组件与样式
   data/                     本任务的持久状态和运行数据
   tests/                    本任务的测试
   templates/                本任务的提交模板
   schemas/                  本任务专用协议（可选）
```

根目录不保存具体任务的业务逻辑、运行数据、专用模板或任务说明文档。具体任务的使用方法只在各自 README 中维护。

## 添加任务

新建 `tasks/<id>/task.json` 和其声明的文件即可。任务发现、侧栏、构建、检查和 Actions 派发不需要登记具体任务名或编写任务专属 workflow。

```json
{
  "id":"my-task", "number":"03", "title":"我的任务", "subtitle":"任务描述",
  "readme":"README.md", "runtime":"runtime", "view":"ui/view.js",
  "submission_entry":"result.txt", "result_pattern":"data/runs/{model}.json",
  "schedule":null
}
```

静态任务 schedule=null。周期任务声明 schedule、可选 credential_secret 和 container_image，并实现 capture/run。完整钩子契约见 [docs/architecture.md](docs/architecture.md)。任务代码属于维护者审阅的可信代码；外部模型产物的隔离方式由任务运行环境负责。

模型在 config/models.json 注册。默认进入主页，从左侧选择任务。任务页只显示已有提交的小型预览卡片，点击后在整个右侧内容区展示完整结果，左侧导航保留；通过“返回列表”或浏览器后退回到卡片列表。未提交模型不占位。预览与完整展示由各任务自己的组件实现。

## 本地使用

Python 3.12+，框架无第三方 Python 依赖；具体任务可能声明自己的额外环境。

```sh
# 先进入含 canvas/ 和 tasks/ 的项目根目录
python --version
python -m canvas validate
python -m unittest discover -s tests -v
python -m canvas serve
# 在浏览器打开 http://localhost:4173
```

看到 `OK` 表示自动测试通过；serve 启动时构建 dist/，终端保持运行即可浏览，Ctrl+C 停止。Windows 也可以将 python 替换为 py -3.12。只预览页面不需要 Docker、Node、npm install 或后端服务。端口被占用时用 `python -m canvas serve --port 4174`。

开发服务器启动时构建；改动文件后在另一个终端进入同一根目录执行 `python -m canvas build` 并刷新。不带提交的任务页没有模型卡片，添加产物的目录与元数据方法见各任务 README。本地预览不会启动周期任务；需要实际执行时使用下述 task 命令，并遵守任务自己的环境要求。所有展示 URL 均相对于站点目录，兼容 GitHub Pages 的仓库子路径。

通用任务 CLI：`python -m canvas task <id> capture`、`python -m canvas task <id> run`。输入、游标和数据结构由任务钩子定义；框架不解释业务数据。任务数据默认可随仓库和 artifacts 公开，数据许可与保留策略应在任务 README 说明。
