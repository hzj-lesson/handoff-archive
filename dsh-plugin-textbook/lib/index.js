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

export class TextbookService extends Service {
  constructor(ctx) {
    super(ctx, 'textbook')
    ctx.mixin('textbook', ['parseOutline', 'textbookToLecture', 'injectIntoPlatform', 'runDemo'])
    console.log('[dsh-plugin-textbook] CONSTRUCTED (service name=textbook)')
    if (process.env.DSH_DEMO === '1') {
      Promise.resolve().then(() => {
        try { this.runDemo() } catch (e) { console.error('[dsh-plugin-textbook] demo failed:', e) }
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
   * 教材大纲 -> 备课平台讲义 JSON（符合 data-junior 模式）。
   * NOTE: 当前为确定性模板生成；接入 DeepSeek API Key 后，
   *       把「内容生成」段替换为 LLM 调用即可（见 generateWithLLM 占位）。
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

  // 占位：接入 DeepSeek Key 后的真实生成入口
  // async generateWithLLM(outline, model = 'deepseek-v4-flash') {
  //   const llm = this.ctx.llm            // dsh-llm 提供的服务
  //   const r = await llm.chat({ model, messages: [{ role: 'user', content: PROMPT(outline) }] })
  //   return JSON.parse(r.content)       // 解析为讲义 JSON
  // }

  /** 自演示：跑一次完整管线并落盘到 /workspace */
  runDemo() {
    const target = '/workspace/demo_data-junior.json'
    const lecture = this.textbookToLecture(DEMO_OUTLINE, { stage: '初中', grade: '九年级', subject: '英语' })
    const res = this.injectIntoPlatform(lecture, target, 221)
    console.log('[dsh-plugin-textbook] DEMO 完成 ->', JSON.stringify(res))
    return res
  }
}

export const name = 'textbook'
export default TextbookService
