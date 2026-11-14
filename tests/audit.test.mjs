// Issue #7: exercise the public loader with mocked upstream; no real accounts/network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WPSLingxiAuthPlugin } from '../index.mjs'

let sequence = 0
const chatPath = '/api/public/v1/agent-runtime/chat/completions'
const sessionPath = '/api/aioffice/v1/cowork/sessions'
const runPath = '/api/public/v1/credits/runs'
const webSessionPath = '/api/aigc/v3/assistant/sessions'
const webChatPath = '/api/aigc/v3/assistant/sessions/w1/completions'
const refusal = '我还在不断学习中，暂时无法回答此问题，请尝试重新提问'

async function exercise({ phase = chatPath, reply, stream = false, verify }) {
  const plugin = await WPSLingxiAuthPlugin()
  const cookie = 'wps_sid=SID' + 'a'.repeat(29)
  let authReads = 0
  const loader = await plugin.auth.loader(async () => {
    authReads++
    return { cookie }
  })
  const original = globalThis.fetch
  const calls = []
  const model = `audit-regression-${++sequence}` // isolate cached runs
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url: String(url), path, cookie: init.headers.Cookie ?? init.headers.cookie })
    if (path === phase) return reply()
    if (path === sessionPath) return Response.json({ code: 'Success', data: { session_id: 's1' } })
    if (path === runPath) return Response.json({ code: 'Success', data: { run_id: 'r1' } })
    // 403 兜底的网页通路：aigc 会话 + SSE completions（正文一帧 + end）
    if (path === webSessionPath) return Response.json({ data: { session_id: 'w1' } })
    if (path === webChatPath) {
      const frames = [
        `event: execution\ndata: ${JSON.stringify({ type: 'text', data: { text: 'web-ok' } })}\n\n`,
        `event: execution\ndata: ${JSON.stringify({ type: 'end' })}\n\n`,
        'event: finish\ndata: {}\n\n',
      ]
      return new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected upstream call: ${url}`)
  }
  try {
    const response = await loader.fetch('https://mock/chat/completions', {
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hello' }] }),
    })
    const text = await response.text()
    await verify({ response, text, calls, authReads })
  } finally {
    globalThis.fetch = original
  }
}

for (const phase of [sessionPath, runPath, chatPath]) {
  for (const status of [200, 400, 401, 403, 404, 422, 500]) {
    test(`AuditFailed at ${phase}, HTTP ${status}: 400, explicit code, no replay/domain fallback`, async () => {
      await exercise({
        phase,
        // Include stale-run and auth keywords to test audit precedence over both paths.
        reply: () => Response.json({ code: 'AuditFailed', message: '会话不存在 cookie: ' + refusal }, { status }),
        verify({ response, text, calls, authReads }) {
          assert.equal(response.status, 400)
          const { error } = JSON.parse(text)
          assert.equal(error.code, 'audit_blocked')
          assert.match(error.message, /暂时无法回答此问题/)
          assert.equal(calls.filter(c => c.path === phase).length, 1)
          assert.ok(calls.every(c => new URL(c.url).hostname === 'lingxi.wps.cn'))
          assert.equal(authReads, 1, 'provider must not ask for another credential')
        },
      })
    })
  }
}

for (const payload of [
  { result: 'AuditFailed', hint: 'blocked' },
  { error: { code: 'AuditFailed', message: 'blocked' } },
  { message: refusal },
  { message: 'auditfailed: blocked' },
  { message: 'x'.repeat(300), code: 'AuditFailed' },
]) {
  test(`audit error fields: ${JSON.stringify(payload).slice(0, 70)}`, async () => {
    await exercise({
      reply: () => Response.json(payload, { status: 400 }),
      verify({ response, text, calls }) {
        assert.equal(response.status, 400)
        assert.equal(JSON.parse(text).error.code, 'audit_blocked')
        assert.equal(calls.filter(c => c.path === chatPath).length, 1)
      },
    })
  })
}

for (const phase of [sessionPath, runPath, chatPath]) {
  for (const payload of [{ result: 'AuditFailed', hint: 'blocked' }, { error: { code: 'AuditFailed', message: 'blocked' } }]) {
    test(`HTTP 200 error envelope at ${phase}: ${JSON.stringify(payload)}`, async () => {
      await exercise({
        phase,
        reply: () => Response.json(payload),
        verify({ response, text, calls }) {
          assert.equal(response.status, 400)
          assert.equal(JSON.parse(text).error.code, 'audit_blocked')
          assert.equal(calls.filter(c => c.path === phase).length, 1)
        },
      })
    })
  }
}

for (const phase of [sessionPath, runPath, chatPath]) {
  test(`plain-text audit after truncation boundary at ${phase}`, async () => {
    await exercise({
      phase,
      reply: () => new Response('x'.repeat(300) + ' AuditFailed', { status: 400 }),
      verify({ response, text, calls }) {
        assert.equal(response.status, 400)
        assert.equal(JSON.parse(text).error.code, 'audit_blocked')
        assert.equal(calls.filter(c => c.path === phase).length, 1)
      },
    })
  })
}

for (const [status, message, expected] of [
  [400, 'unknown model', 404], [404, 'model not found', 404],
  [422, 'invalid parameter', 404], [401, 'cookie unauthorized', 401],
  [503, 'unavailable', 503],
  [400, '审核服务异常', 404], [400, 'NotAuditFailedYet', 404],
]) {
  test(`non-audit classification remains ${status}/${message} -> ${expected}`, async () => {
    await exercise({
      reply: () => Response.json({ message }, { status }),
      verify({ response, text }) {
        assert.equal(response.status, expected)
        assert.equal(JSON.parse(text).error.code, 'upstream_error')
      },
    })
  })
}

// 2026-11 起服务端对 agent-runtime 强制 WPS2 签名：纯 HTTP 明文 Cookie 一律
// 403 PermissionDenied（issue #13 同现象）。插件契约变更：chat 阶段的 403
// （非 audit、非登录失效）改为自动回落 aigc v3 网页通路，而不是映射成 404。
test('403 permission denied at chat phase falls back to the aigc web plane', async () => {
  await exercise({
    reply: () => Response.json({ code: 'PermissionDenied', message: '无权限' }, { status: 403 }),
    verify({ response, text, calls }) {
      assert.equal(response.status, 200)
      const parsed = JSON.parse(text)
      assert.equal(parsed.choices[0].message.content, 'web-ok')
      assert.equal(parsed.choices[0].finish_reason, 'stop')
      assert.equal(calls.filter(c => c.path === chatPath).length, 1)
      assert.equal(calls.filter(c => c.path === webSessionPath).length, 1)
      assert.equal(calls.filter(c => c.path === webChatPath).length, 1)
    },
  })
})

// 登录失效（403 + 鉴权关键词）不触发网页通路：账号问题换通路解决不了，必须让用户重登。
test('403 with auth keywords stays 401 without web fallback', async () => {
  await exercise({
    reply: () => Response.json({ message: '登录已失效，请重新登录' }, { status: 403 }),
    verify({ response, text, calls }) {
      assert.equal(response.status, 401)
      assert.equal(JSON.parse(text).error.code, 'upstream_error')
      assert.equal(calls.filter(c => c.path === webSessionPath).length, 0)
    },
  })
})

// 403 兜底在 session/run 阶段不生效（run 建不出来时 chat 还没发生）。
// postJson 给 403 补的 hint 含「登录」→ 既有映射归 401（与改动前一致）。
test('403 at session phase still maps to 401 without web fallback', async () => {
  await exercise({
    phase: sessionPath,
    reply: () => Response.json({ message: '无权限' }, { status: 403 }),
    verify({ response, text, calls }) {
      assert.equal(response.status, 401)
      assert.equal(JSON.parse(text).error.code, 'upstream_error')
      assert.equal(calls.filter(c => c.path === webSessionPath).length, 0)
    },
  })
})

for (const stream of [false, true]) {
  for (const partial of [false, true]) {
    test(`HTTP 200 SSE AuditFailed, stream=${stream}, partial=${partial}: no replay or false completion`, async () => {
      const frames = [
        ...(partial ? [{ code: 'Success', choices: [{ text: 'partial' }] }] : []),
        { code: 'AuditFailed', message: refusal },
      ]
      await exercise({
        stream,
        reply: () => new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        }),
        verify({ response, text, calls, authReads }) {
          assert.equal(response.status, stream ? 200 : 400)
          assert.match(text, /audit_blocked/)
          assert.match(text, /暂时无法回答此问题/)
          assert.doesNotMatch(text, /\[DONE\]|"finish_reason":"stop"/)
          assert.equal(calls.filter(c => c.path === chatPath).length, 1)
          assert.equal(authReads, 1)
        },
      })
    })
  }
}

test('normal assistant content mentioning AuditFailed is not an audit error', async () => {
  await exercise({
    reply: () => new Response('data: ' + JSON.stringify({ code: 'Success', choices: [{ text: 'AuditFailed 审核', finish_reason: 'stop' }] }) + '\n\n'),
    verify({ response, text }) {
      assert.equal(response.status, 200)
      assert.equal(JSON.parse(text).choices[0].message.content, 'AuditFailed 审核')
    },
  })
})
