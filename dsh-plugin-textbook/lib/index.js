import { Service } from '@deepseek-ai/cordis'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// 演示用的示例教材大纲（九年级英语 Unit 1）
const DEMO_OUTLINE = `Unit 1 一般现在时（九年级 英语）
- 知识点1：be 动词 (am/is/are) 的人称与数的一致
- 知识点2：实义动词第三人称单数 (三单) 的构成规则 (-s / -es / -ies)
- 知识点3：频度副词 (always / usually / often / every day) 与一般现在的搭配
例题：用所给动词适当形式填空 — He ___ (go) to school by bike every day.
例题：改为否定句 — They are students.`

/* ================= LLM 配置（免费档优先，全部走环境变量，不硬编码密钥） =================
 * LLM_API_KEY   必填。免费档：智谱 open.bigmodel.cn / 硅基流动 siliconflow.cn 注册即得
 * LLM_BASE_URL  默认智谱 OpenAI 兼容地址；硅基流动填 https://api.siliconflow.cn/v1
 * LLM_MODEL     默认 glm-4-flash（智谱免费）；硅基流动免费模型如 Qwen/Qwen2.5-7B-Instruct
 * LLM_TIMEOUT   超时毫秒，默认 120000
 */
const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const DEFAULT_MODEL = 'glm-4-flash'

const LECTURE_SYSTEM_PROMPT = `你是一位中国资深一线教师兼教研员。你的任务：把给定的教材大纲，编写成可直接用于备课平台的讲义。
严格要求：
1. 只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码围栏。
2. JSON 必须包含且仅包含这些字段（值全部用中文）：
   - "备课方案": 字符串，含课时安排与每课时主线
   - "课堂讲义": {"核心知识点": "Markdown 字符串，含知识点表格或条目"}
   - "重点难点解析": 字符串，写清重点与常见易错点
   - "典型例题精讲": [{"题":"…","解析":"…"}]，至少 2 道
   - "课后作业": [{"difficulty":"易|中|较难|难","title":"…","questions":[{"q":"…","a":"…"}]}]，必须四档各一个
   - "课后反馈": 字符串
3. 学科术语、标点使用规范；涉台港澳一律称「中国台湾/中国香港/中国澳门」。
4. 输出必须是合法 JSON，键名用中文双引号。`

function buildLecturePrompt(outline, opts = {}) {
  const meta = `学段：${opts.stage || '初中'}｜年级：${opts.grade || '九年级'}｜学科：${opts.subject || '英语'}`
  return `${meta}\n\n下面是教材大纲，请据此编写讲义 JSON：\n\n${String(outline || '')}`
}

export class TextbookService extends Service {
  constructor(ctx) {
    super(ctx, 'textbook')
    ctx.mixin('textbook', ['parseOutline', 'textbookToLecture', 'textbookToLectureLLM', 'generateWithLLM', 'injectIntoPlatform', 'runDemo'])
    console.log('[dsh-plugin-textbook] CONSTRUCTED (service name=textbook)')
    if (process.env.DSH_DEMO === '1') {
      Promise.resolve().then(async () => {
        try { await this.runDemo() } catch (e) { console.error('[dsh-plugin-textbook] demo failed:', e) }
      })
    }
  }

  /** 解析教材大纲：按「单元 / 知识点 / 例题」分段 */
  parseOutline(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    let unit = '未命名单元'
    const points = []
    const examples = []
    for (const line of lines) {
      if (/^(unit|模块|第\s*\d+\s*单元|chapter)\b/i.test(line)) {
        const m = line.match(/^(?:unit|模块|第\s*\d+\s*单元|chapter)\s*[:：]?\s*(.+)$/i)
        if (m) unit = m[1].trim()
        continue
      }
      if (/^[-•*]\s*/.test(line)) { points.push(line.replace(/^[-•*]\s*/, '')); continue }
      if (/^例题/.test(line)) { examples.push(line.replace(/^例题[:：]?\s*/, '')); continue }
      if (/^\d+[.、]/.test(line)) { points.push(line.replace(/^\d+[.、]\s*/, '')); continue }
    }
    return { unit, points, examples }
  }

  /**
   * 确定性模板生成（无需 Key，离线可用）。
   * 也是 LLM 生成失败时的兜底结果。
   */
  textbookToLecture(text, opts = {}) {
    const parsed = this.parseOutline(text)
    const stage = opts.stage || '初中'
    const grade = opts.grade || '九年级'
    const subject = opts.subject || '英语'
    const points = parsed.points.length ? parsed.points : ['（待补充知识点）']
    const kpTable = [
      '| 序号 | 核心知识点 |',
      '| --- | --- |',
      ...points.map((p, i) => `| ${i + 1} | ${p} |`)
    ].join('\n')
    const examples = parsed.examples.length ? parsed.examples : ['（示例）用所给词适当形式填空。']

    return {
      stage, grade, subject,
      chapter: parsed.unit,
      备课方案: `本单元共 ${points.length} 个核心知识点，建议分 2 课时：第1课时讲练「${points[0]}」，第2课时综合与易错辨析。`,
      课堂讲义: {
        核心知识点: `### 一、课内要点\n${kpTable}`
      },
      重点难点解析: '重点：be 动词一致性与三单变化规则。易错：主语为第三人称单数时动词忘加 -s；频度副词位置误放句首。',
      典型例题精讲: examples.map((ex) => ({
        题: ex,
        解析: '【解析】结合一般现在时结构，先判断主语人称与数，再确定 be 动词或实义动词三单形式。'
      })),
      课后作业: [
        { difficulty: '易', title: '基础巩固', questions: [{ q: '用 be 动词填空：I ___ a student.', a: 'am' }] },
        { difficulty: '中', title: '能力提升', questions: [{ q: '用动词适当形式：She ___ (like) music.', a: 'likes' }] },
        { difficulty: '较难', title: '综合应用', questions: [{ q: '改为否定句：He goes to the park.', a: "He doesn't go to the park." }] },
        { difficulty: '难', title: '拓展探究', questions: [{ q: '写作：用一般现在时写 3 句关于你日常生活的句子。', a: '（开放题，按生活实际作答）' }] }
      ],
      课后反馈: '课堂观察 + 作业正确率，针对三单错误集中复盘。'
    }
  }

  /** 容错解析：剥离 ```json 围栏、说明文字，抓取最外层 {...} */
  parseLectureJSON(content) {
    let s = String(content || '').trim()
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) throw new Error('LLM 返回内容中没有 JSON 对象')
    s = s.slice(a, b + 1)
    try {
      return JSON.parse(s)
    } catch (e) {
      throw new Error('LLM 返回 JSON 解析失败：' + e.message)
    }
  }

  /**
   * 真实 LLM 生成：OpenAI 兼容协议（智谱 / 硅基流动 / DeepSeek 官方皆可用）。
   * 未配置 LLM_API_KEY 时直接抛错，调用方（textbookToLectureLLM）会回退模板。
   */
  async generateWithLLM(outline, opts = {}) {
    const key = opts.apiKey || process.env.LLM_API_KEY
    if (!key) throw new Error('缺少 LLM_API_KEY（免费档：智谱 open.bigmodel.cn 或 硅基流动 siliconflow.cn 注册即得）')
    const base = String(opts.baseURL || process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
    const model = opts.model || process.env.LLM_MODEL || DEFAULT_MODEL
    const timeoutMs = Number(opts.timeoutMs || process.env.LLM_TIMEOUT || 120000)
    const url = base + '/chat/completions'
    const body = {
      model,
      temperature: opts.temperature ?? 0.3,
      messages: [
        { role: 'system', content: LECTURE_SYSTEM_PROMPT },
        { role: 'user', content: buildLecturePrompt(outline, opts) }
      ]
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let resp
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: ac.signal
      })
    } catch (e) {
      throw new Error('LLM 请求异常：' + (e && e.name === 'AbortError' ? '超时' : e.message))
    } finally {
      clearTimeout(timer)
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      throw new Error('LLM 请求失败 HTTP ' + resp.status + '：' + String(t).slice(0, 300))
    }
    const data = await resp.json()
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (!content) throw new Error('LLM 返回内容为空')
    return this.parseLectureJSON(content)
  }

  /**
   * 教材大纲 -> 讲义 JSON（走 LLM）。失败自动回退到模板，保证管线不中断。
   */
  async textbookToLectureLLM(text, opts = {}) {
    const parsed = this.parseOutline(text)
    const fallback = this.textbookToLecture(text, opts)
    try {
      const json = await this.generateWithLLM(text, opts)
      return {
        ...fallback,
        ...json,
        stage: json.stage || fallback.stage,
        grade: json.grade || fallback.grade,
        subject: json.subject || fallback.subject,
        chapter: json.chapter || parsed.unit
      }
    } catch (e) {
      console.warn('[dsh-plugin-textbook] LLM 生成失败，已回退模板：', e.message)
      return fallback
    }
  }

  /** 把讲义注入到备课平台数据层文件（JSON 数组，模拟 data-junior） */
  injectIntoPlatform(lecture, targetPath, atIndex) {
    const idx = (typeof atIndex === 'number') ? atIndex : 1e9
    let arr = []
    if (existsSync(targetPath)) {
      try { arr = JSON.parse(readFileSync(targetPath, 'utf8')) } catch { arr = [] }
    }
    if (!Array.isArray(arr)) arr = [arr]
    arr.splice(Math.min(idx, arr.length), 0, lecture)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, JSON.stringify(arr, null, 2), 'utf8')
    return { path: targetPath, total: arr.length, insertedAt: Math.min(idx, arr.length - 1) }
  }

  /** 自演示：配置了 LLM_API_KEY 就走真实生成，否则用模板 */
  async runDemo() {
    const target = process.env.DSH_OUT || '/workspace/demo_data-junior.json'
    const useLLM = !!process.env.LLM_API_KEY
    const lecture = useLLM
      ? await this.textbookToLectureLLM(DEMO_OUTLINE, { stage: '初中', grade: '九年级', subject: '英语' })
      : this.textbookToLecture(DEMO_OUTLINE, { stage: '初中', grade: '九年级', subject: '英语' })
    const res = this.injectIntoPlatform(lecture, target, 221)
    console.log('[dsh-plugin-textbook] DEMO 完成 ->', JSON.stringify(res), useLLM ? '(LLM 真实生成)' : '(模板生成)')
    return res
  }
}

export const name = 'textbook'
export default TextbookService
