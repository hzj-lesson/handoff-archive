/* 本地验证：LLM 接线是否正确（用假服务模拟 OpenAI 兼容接口，不消耗真实额度）
   运行：node _llm_test.mjs   期望输出 RESULT: PASS */
import http from 'node:http'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

// 1) 生成去依赖桩（把 cordis 的 Service 换成本地空实现，其余逻辑与线上文件一致）
const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  .replace(/import \{ Service \} from '@deepseek-ai\/cordis'/,
    'class Service { constructor(ctx, name){ this.ctx = ctx || {}; this.name = name } }')
writeFileSync(new URL('./_stub.mjs', import.meta.url), src)
const { TextbookService } = await import('./_stub.mjs')

const SAMPLE = {
  备课方案: '本单元分 2 课时：第1课时 be 动词，第2课时三单。',
  课堂讲义: { 核心知识点: '| 1 | be 动词 |' },
  重点难点解析: 'LLM 生成的重难点',
  典型例题精讲: [{ 题: 'He ___ (go)', 解析: '三单 goes' }, { 题: '改为否定句', 解析: "doesn't" }],
  课后作业: [
    { difficulty: '易', title: '基础', questions: [{ q: 'I ___ a student.', a: 'am' }] },
    { difficulty: '中', title: '提升', questions: [{ q: 'She ___ music.', a: 'likes' }] },
    { difficulty: '较难', title: '综合', questions: [{ q: '否定句', a: "doesn't go" }] },
    { difficulty: '难', title: '拓展', questions: [{ q: '写 3 句', a: '开放' }] }
  ],
  课后反馈: 'LLM 生成的反馈'
}

const out = []
const ok = (n, c, extra) => out.push((c === true ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? '  -> ' + extra : ''))

// 2) 起一个假 LLM 服务
let mode = 'ok'
const calls = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') })
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'http500') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'boom' })) }
    if (mode === 'badjson') {
      return res.end(JSON.stringify({ choices: [{ message: { content: '抱歉，我无法输出 JSON' } }] }))
    }
    res.end(JSON.stringify({
      choices: [{ message: { content: '这是您的讲义：\n```json\n' + JSON.stringify(SAMPLE) + '\n```\n祝教学顺利。' } }]
    }))
  })
})
await new Promise(r => server.listen(0, r))
const port = server.address().port
const svc = new TextbookService({ mixin: () => {} })

try {
  // 3) 未配 Key → 明确报错
  delete process.env.LLM_API_KEY
  let threw = false
  try { await svc.generateWithLLM('x') } catch (e) { threw = /LLM_API_KEY/.test(e.message) }
  ok('未配 Key 时明确报错', threw)

  // 4) 正常调用：请求构造 + 容错解析（带围栏和前后废话）
  process.env.LLM_API_KEY = 'test-key-123'
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.LLM_MODEL = 'glm-4-flash'
  const r1 = await svc.generateWithLLM('Unit 1 一般现在时\n- 知识点1：be 动词')
  const last = calls[calls.length - 1]
  ok('请求打到 /v1/chat/completions', last.url === '/v1/chat/completions', last.url)
  ok('Authorization 头正确', last.auth === 'Bearer test-key-123', last.auth)
  ok('请求体含 system+user 且用指定模型', last.body.model === 'glm-4-flash' && last.body.messages.length === 2, last.body.model)
  ok('容错解析（剥围栏+前后文字）', r1.备课方案 === SAMPLE.备课方案, r1.备课方案.slice(0, 12) + '…')

  // 5) 上层封装：LLM 字段覆盖 + 元信息由模板补齐
  const lec = await svc.textbookToLectureLLM('Unit 1 一般现在时\n- 知识点1：be 动词', { grade: '九年级' })
  ok('合并后保留 LLM 内容', lec.重点难点解析 === 'LLM 生成的重难点')
  ok('合并后补齐学段/年级/学科', lec.stage === '初中' && lec.grade === '九年级' && lec.subject === '英语', `${lec.stage}/${lec.grade}/${lec.subject}`)
  ok('作业四档齐全', Array.isArray(lec.课后作业) && lec.课后作业.length === 4, lec.课后作业.length)

  // 6) 失败兜底：HTTP 500
  mode = 'http500'
  const lec2 = await svc.textbookToLectureLLM('Unit 1 一般现在时\n- 知识点1：be 动词')
  ok('HTTP 500 自动回退模板', typeof lec2.备课方案 === 'string' && lec2.课后作业.length === 4 && lec2.重点难点解析 !== 'LLM 生成的重难点')

  // 7) 失败兜底：返回非 JSON
  mode = 'badjson'
  const lec3 = await svc.textbookToLectureLLM('Unit 1 一般现在时\n- 知识点1：be 动词')
  ok('返回非 JSON 自动回退模板', lec3.备课方案.indexOf('本单元共') === 0, lec3.备课方案.slice(0, 10))

  // 8) 注入落盘仍可用
  mode = 'ok'
  const res = await (async () => {
    const l = await svc.textbookToLectureLLM('Unit 1 一般现在时\n- 知识点1：be 动词')
    return svc.injectIntoPlatform(l, './_tmp_out.json', 221)
  })()
  ok('注入平台文件成功', res.total === 1, JSON.stringify(res))
} catch (e) {
  out.push('RUNTIME FAIL: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e))
} finally {
  server.close()
  try { unlinkSync(new URL('./_stub.mjs', import.meta.url)) } catch {}
  try { unlinkSync(new URL('./_tmp_out.json', import.meta.url)) } catch {}
}

console.log(out.join('\n'))
console.log('RESULT: ' + (out.every(s => s.indexOf('PASS') === 0) ? 'PASS' : 'FAIL'))
