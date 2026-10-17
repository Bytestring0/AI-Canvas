# 框架扩展契约

框架只负责发现、校验、调度、打包与加载插件。任务目标、环境、数据格式、提交文件类型、执行规则和可视化均由 tasks/<id>/ 自己拥有。

## task.json

必填：id（小写 slug，与目录相同）、title、readme、runtime、view、submission_entry。可选：number、subtitle、result_pattern、schedule、credential_secret、container_image。所有文件路径都相对于任务目录，不得越界。

schedule 格式：`{"timezone":"Asia/Shanghai","interval_minutes":10,"weekdays":[0,1,2,3,4],"windows":[["09:00","17:00"]]}`。weekdays 使用 Python 周一=0。根目录工作流每10分钟轮询，各任务负责精确的输入游标、重复运行保护、假期与业务条件。需要其他调度间隔时同时调整通用轮询频率；它不是实时定时器。

## runtime/__init__.py

- `validate(task, entries)`：校验本任务专用配置与提交。entries 为 (提交目录 Path, manifest dict) 列表。
- `build_payload(task)`：返回本任务需要的可 JSON 序列化的展示数据。禁止在构建中执行外部产物。
- `capture()`：定时任务获取当前输入，返回字符串游标；没有可运行输入时返回 None。
- `run(cursor, unsafe_local=False)`：按游标执行业务逻辑，写自己的 data/。任务负责安全地执行外部代码和状态幂等。

框架将 capture 的返回值记录到任务自己的 data/capture.json，run 默认读取该游标。凭据通过 CANVAS_DATA_TOKEN 环境变量注入 capture job，来自 task.json 的 credential_secret；run job 不接收该凭据。若任务需要多种凭据，可扩展通用凭据映射契约，不要向根目录添加具体服务名。

## ui/view.js

导出 `mount(root, context)`，可返回清理函数。context 包含 task、model、models、submission、submissions、openDoc(title,text)。task.payload 是 build_payload 的结果。页面外壳负责独立主页、侧栏任务选择、已提交模型的卡片列表与右侧完整成果页；点击卡片后成果替换列表并占满右侧内容区，通过返回列表链接或浏览器后退恢复列表。插件只管理 root 内容，不改父级导航。成果页不是弹窗，左侧任务导航始终可用。

可选导出 `preview(root, context)`，绘制小型卡片缩略图并返回清理函数。仅对已有提交调用；不提供此钩子时卡片显示“查看结果”。完整 `mount` 只在点击展开后调用。

成果页右上角提供“查看 README”，读取当前展示版本提交的 README.md。mount 的 context 还提供 `setRevision(id)`，插件在选择作品版本或展示当前执行策略时调用，让通用 README 按钮与实际展示版本同步；未调用时默认使用最新提交版本。按钮与文档展示由框架统一管理。

同目录提供 styles.css。构建复制整个 ui/ 到 dist/task-ui/<id>/；插件可从 ../../ui.js 使用通用转义、时间格式和文件下载工具。构建不会根据任务 kind 分支。

## 提交与结果

通用提交位于 submissions/<task>/<model>/submission.json，含 schema_version=1、task、model、确切 model_version 与 revisions。每版包含 id、effective_from、directory、note，并交付 task.submission_entry 和 README.md。专用字段由任务自己的校验器规定。effective_from 可以是 ISO 日期或带时区的时间戳，其具体生效语义由任务解释。

如果声明 result_pattern（如 data/runs/{model}.json），构建读取每个模型的结果并挂在 submission.run。框架不解释结果结构。JSON 静态接口 dist/data/catalog.json 提供 tasks、models、submissions 与通用指南。原始业务数据不自动发布到 Pages。

## Actions

通用 plan → matrix capture → matrix execute → 聚合 persist → Pages。capture 与 execute 使用同一代码提交；写回前检查仓库 HEAD，拒绝覆盖运行期间的新提交。状态只写入各任务 data/，不覆盖任务代码。失败输出可从 artifacts 取回；没有自动强推或自动合并。

添加任务不应修改根目录业务代码。需要新运行语言或协议时，应先扩展通用钩子，再让任务声明自己的实现。PR 只验证与构建，不执行未审阅产物。任务 runtime 与工作流本身仍需维护者审阅。

## 测试

根目录 tests/ 检查框架契约，并通过通用 load_tests 钩子发现各任务 tests/。任务测试模块使用本任务特有前缀，避免不同任务同名模块冲突。各任务的外部凭据、容器与云端集成验证状态在自己的文档中记录。
