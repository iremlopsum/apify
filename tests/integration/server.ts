import http from 'node:http'

export interface TestServer {
  baseUrl: string
  callCounts: Map<string, number>
  close: () => Promise<void>
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

export function startServer(): Promise<TestServer> {
  const callCounts = new Map<string, number>()

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, `http://127.0.0.1`)
      const method = req.method!
      const pathname = url.pathname
      const countKey = `${method} ${pathname}`
      callCounts.set(countKey, (callCounts.get(countKey) ?? 0) + 1)

      try {
        if (method === 'GET' && pathname === '/hello') {
          sendJson(res, 200, { message: 'hello' })

        } else if (method === 'GET' && pathname.startsWith('/users/')) {
          const id = pathname.split('/')[2]
          if (!id) {
            res.writeHead(404)
            res.end()
          } else {
            sendJson(res, 200, { id, name: `User ${id}` })
          }

        } else if (method === 'GET' && pathname === '/search') {
          const params: Record<string, string> = {}
          url.searchParams.forEach((v, k) => { params[k] = v })
          sendJson(res, 200, { params })

        } else if (method === 'POST' && pathname === '/echo') {
          const raw = await readBody(req)
          let body: unknown = null
          if (raw) {
            try {
              body = JSON.parse(raw) as unknown
            } catch {
              sendJson(res, 400, { error: 'Invalid JSON' })
              return
            }
          }
          sendJson(res, 200, { body, contentType: req.headers['content-type'] ?? null })

        } else if (method === 'GET' && pathname === '/headers') {
          sendJson(res, 200, { headers: req.headers })

        } else if (pathname.startsWith('/status/')) {
          const code = parseInt(pathname.split('/')[2], 10)
          res.writeHead(isNaN(code) ? 400 : code)
          res.end()

        } else if (method === 'GET' && pathname === '/flaky') {
          const FLAKY_FAIL_COUNT = 2 // fail this many times, then succeed
          // `count` is read AFTER the shared increment at the top of the handler,
          // so it reflects the current call number (1-based):
          //   call 1 → count=1, 1<=2 → 503
          //   call 2 → count=2, 2<=2 → 503
          //   call 3 → count=3, 3<=2 is false → 200 { recovered: true }
          const count = callCounts.get('GET /flaky') ?? 0
          if (count <= FLAKY_FAIL_COUNT) {
            res.writeHead(503)
            res.end()
          } else {
            sendJson(res, 200, { recovered: true })
          }

        } else if (method === 'POST' && pathname === '/graphql') {
          const raw = await readBody(req)
          const { query, variables = {} } = JSON.parse(raw) as {
            query: string
            variables?: Record<string, unknown>
          }
          if (query.includes('gqlHello')) {
            sendJson(res, 200, { data: { hello: 'world' } })
          } else if (query.includes('gqlUser')) {
            sendJson(res, 200, { data: { user: { id: variables.id, name: `User ${variables.id}` } } })
          } else if (query.includes('gqlError')) {
            sendJson(res, 200, { errors: [{ message: 'Something went wrong' }] })
          } else if (query.includes('gqlMutation')) {
            sendJson(res, 200, { data: { createUser: { id: '99', name: variables.name ?? 'New' } } })
          } else {
            res.writeHead(400)
            res.end()
          }

        } else {
          res.writeHead(404)
          res.end()
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500)
          res.end()
        }
      }
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address() as { address: string; port: number }
      resolve({
        baseUrl: `http://${addr.address}:${addr.port}`,
        callCounts,
        close: () => new Promise<void>((r, rj) => {
          server.closeAllConnections()
          server.close((err) => (err ? rj(err) : r()))
        }),
      })
    })
  })
}
