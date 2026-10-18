# 任务 02：雨夜便利店

目标：比较不同 AI 对同一创作提示词的 HTML 页面交付。框架只收录与预览作品，不代替模型创作。

## 内容提示词

统一创作题目保存在本目录的 `prompt.md`，让所有参赛 AI 阅读同一份完整提示词即可。收录时不要求提示词哈希。如果要保留不同题目的比赛，可新建 task ID 与 prompt 文件。

## 给参赛 AI 的交付提示词

操作者应将创作题目全文与下列交付要求合并在同一条消息里；不能只提供 prompt.md 文件名或让 AI 去访问仓库。

> 你看不到项目文件。请根据本条消息正文已经完整给出的创作题目创作「雨夜便利店」。保持内容提示词原意，自主完成视觉与交互。交付单个自包含 index.html 以及 README.md，所有 CSS、JavaScript、图片、字体、声音资源必须内联或使用 data URI；不要依赖 CDN、外部网络、npm、构建过程或后端。不要在 README 中放弃实际实现。代码运行于 sandbox="allow-scripts" 的 iframe，拥有脚本执行权限，没有父页面或同源权限，不可访问父页面、调用网络、提交表单、跳转顶层、弹窗、下载文件或读取本地文件。用原生 HTML/CSS/JS，兼容现代 Chromium、Firefox、Safari，适配 390px 移动屏与桌面，支持键盘操作和 prefers-reduced-motion。不要调用 AI 接口。stdout 不是此任务的交付渠道；请给出可以保存成文件的 HTML 全文。README 写明具体模型版本、生成日期、创作提示词引用、实现与已知限制。每个文件不超过 5 MB。

## 预览环境

- 静态 GitHub Pages，无后端。前端将 HTML 作为 `srcdoc` 加载，沙箱只开放 allow-scripts。
- 首条 CSP 为 `default-src 'none'`，允许内联脚本与样式、data URI 图片/字体/媒体；禁止网络、子 frame、表单与 base URL。
- localStorage、Service Worker、父页面 DOM、外链模块和 fetch 不可用。交互状态放在内存；刷新后重置。
- CSS/JS 使用内联，文件路径不会作为资源基址提供。脚本自己引用外部文件会失败，即使该文件随产物保存。
- 自定义评分不内置。任务页仅列出已提交模型的缩略卡片；点击展开后可切换作品版本、查看 HTML 源码。
- 单个作品可能占用 CPU；iframe 是浏览器权限边界，不是防止所有卡死的资源配额系统。合并前请人工审阅文件。

## 添加作品

```text
submissions/rainy-store/模型名/
  index.html
  README.md
```

目录名就是模型显示名，无需提前注册或建立 submission.json，也无需填写哈希、日期和版本说明。需要保留多版作品时，可使用 `revisions/v1/`、`revisions/v2/`，会按版本目录自然顺序自动识别；旧清单仍兼容，模板只用于选填版本信息。

运行 `python -m canvas build` 并刷新；推送 main 后 Pages 自动发布。HTML 只作为资产复制，构建不会执行作品 JavaScript。
