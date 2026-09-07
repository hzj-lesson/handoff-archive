# dsh-plugin-textbook · 教材大纲 → 讲义 JSON 自动生成器

DeepSeek Harness（`deepseek-ai/deepseek-harness`）的 cordis 插件。给一份教材大纲，产出可直接注入「教师备课助手」平台 `data-junior` 数据层的讲义 JSON。

**已接好免费档 LLM**（OpenAI 兼容协议），没有 Key 时自动回退到内置模板，管线永不中断。

---

## 一、拿一个免费的 API Key（二选一，都是注册即送）

### 方案 A：智谱开放平台（推荐，国内直连）
1. 打开 https://open.bigmodel.cn 注册/登录
2. 右上角 →「API Keys」→ 复制 Key
3. 免费模型：**`glm-4-flash`**（默认，已写在代码里）

### 方案 B：硅基流动 SiliconFlow（小模型永久免费）
1. 打开 https://cloud.siliconflow.cn 注册/登录
2. 左侧「API 密钥」→ 新建并复制
3. 免费模型示例：**`Qwen/Qwen2.5-7B-Instruct`**

> 两个平台的具体免费模型以官网「模型广场 / 定价页」当时标注为准，能换就行——本插件不绑死任何一家。

---

## 二、配置环境变量（密钥只放环境，不写进代码）

**Windows PowerShell**
```powershell
$env:LLM_API_KEY="你的Key"
$env:LLM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"   # 智谱，默认可省略
$env:LLM_MODEL="glm-4-flash"                                # 默认可省略
```
若用硅基流动：`$env:LLM_BASE_URL="https://api.siliconflow.cn/v1"`；`$env:LLM_MODEL="Qwen/Qwen2.5-7B-Instruct"`

**Git Bash / macOS / Linux**
```bash
export LLM_API_KEY="你的Key"
export LLM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
export LLM_MODEL="glm-4-flash"
```

可选：`LLM_TIMEOUT`（毫秒，默认 120000）、`DSH_OUT`（demo 输出路径，默认 `/workspace/demo_data-junior.json`）。

---

## 三、跑起来

```bash
nvm use 22.19.0                 # 必须 Node ≥ 22.19
DSH_DEMO=1 npx @deepseek-ai/dsh web
```

- **配了 `LLM_API_KEY`** → 用真 AI 生成讲义，日志末尾显示 `(LLM 真实生成)`
- **没配** → 用确定性模板生成，显示 `(模板生成)`，离线也能验管线

在代码里直接调用：
```js
const lecture = await ctx.textbook.textbookToLectureLLM(outlineText, {
  stage: '初中', grade: '九年级', subject: '英语'
})
const res = ctx.textbook.injectIntoPlatform(lecture, '/path/to/data-junior.json', 221)
```

---

## 四、容错设计（重点）

免费小模型输出长 JSON 时可能夹带废话、代码围栏，甚至截断。插件已内置三层兜底：

1. **容错解析**：自动剥掉 ` ```json ` 围栏与前后说明文字，只取最外层 `{...}`
2. **失败回退**：HTTP 报错 / 超时 / 解析失败 → 自动用模板生成并打警告，管线不崩
3. **字段合并**：LLM 结果缺的元信息（学段/年级/学科/章节）用模板值补齐，保证注入平台不缺字段

想更稳：一次只生成一章（别把整本教材一次丢进去），`temperature` 保持 0.3 左右。

---

## 五、换成付费/更强模型

任何 OpenAI 兼容接口都能用，改环境变量即可：

| 服务商 | LLM_BASE_URL | 典型模型 |
|---|---|---|
| 智谱（免费档） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 硅基流动（免费档） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-chat` |

---

## 六、安装约定（Harness 侧，别踩坑）

1. 插件放 profile 的 node_modules 链：`~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-plugin-textbook`（只丢 npx 缓存会找不到）
2. `~/.dsh/profiles/web/cordis.patch.yml` 的 `dispose` 列表加 `- name: '@deepseek-ai/dsh-plugin-textbook'`
3. 入口是 `export default class XService extends Service`，**不要写 TS 的 `declare module`**
4. Node 必须 ≥ 22.19（更低版本缺 `node:zlib.createZstdDecompress`，Harness 启动即失败）

---

## 七、自测

`node _llm_test.mjs` —— 用本地假服务验证「未配 Key 报错 / 请求构造 / 容错解析 / 合并补字段 / 两次失败兜底 / 注入落盘」，不消耗真实额度，期望 `RESULT: PASS`。
