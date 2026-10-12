import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { register, deactivate } from './index.js'

interface RegistrySpy {
  hooks: Record<string, (payload: unknown) => unknown>
  rpcs: Record<string, (params: Record<string, unknown>) => unknown>
  settings?: unknown
  context: {
    id: string
    version: string
    runtime: { mode: string; configDirectory: string }
    logger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
    settings: () => Record<string, unknown>
    notify: ReturnType<typeof vi.fn>
  }
}

function createRegistry(): RegistrySpy {
  const registry: RegistrySpy = {
    hooks: {},
    rpcs: {},
    context: {
      id: 'openfox-telegram',
      version: '1.0.1',
      runtime: { mode: 'production', configDirectory: '/tmp' },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      settings: () => ({}),
      notify: vi.fn(),
    },
  }
  return registry
}

function asRegistry(spy: RegistrySpy) {
  return {
    context: spy.context,
    runtime: spy.context.runtime,
    registerHook: (event: string, handler: (payload: unknown) => unknown) => {
      spy.hooks[event] = handler
    },
    registerRpc: (method: string, handler: (params: Record<string, unknown>) => unknown) => {
      spy.rpcs[method] = handler
    },
    registerSettings: (schema: unknown) => {
      spy.settings = schema
    },
  }
}

describe('plugin registration', () => {
  // Keep the suite hermetic: the connection test probes the OpenFox REST API,
  // so a real `fetch` would otherwise hit http://127.0.0.1:10369.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network disabled in tests')
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers settings, the turn.completed hook, RPCs and notifies', async () => {
    const spy = createRegistry()
    await register(asRegistry(spy) as never)

    expect(spy.settings).toBeDefined()
    const fields = (spy.settings as { fields: { key: string; type: string; rpcMethod?: string }[] }).fields
    expect(fields.length).toBeGreaterThanOrEqual(10)
    const button = fields.find((field) => field.key === 'testConnection')
    expect(button).toMatchObject({ type: 'button', rpcMethod: 'telegram.test' })
    expect(Object.keys(spy.hooks)).toEqual(['turn.completed'])
    expect(Object.keys(spy.rpcs).sort()).toEqual(['telegram.status', 'telegram.test'])
    expect(spy.context.notify).toHaveBeenCalledTimes(1)
  })

  it('throws and stays silent on failure when the connection test fails', async () => {
    const spy = createRegistry()
    await register(asRegistry(spy) as never)
    spy.context.notify.mockClear()

    await expect(spy.rpcs['telegram.test']!({})).rejects.toThrow()

    expect(spy.context.notify).not.toHaveBeenCalled()
    deactivate()
  })

  it('reports an unconfigured status and survives a hook call without config', async () => {
    const spy = createRegistry()
    await register(asRegistry(spy) as never)

    const status = (await spy.rpcs['telegram.status']!({})) as { configured: boolean; running: boolean }
    expect(status.configured).toBe(false)
    expect(status.running).toBe(true)

    // No bot token configured -> hook must be a no-op, never throw.
    await expect(spy.hooks['turn.completed']!({ sessionId: 's1', data: { reason: 'waiting_for_user' } })).resolves.toBeUndefined()

    await expect(spy.rpcs['telegram.test']!({})).rejects.toThrow()

    deactivate()
  })

  it('stops the bridge on deactivate', async () => {
    const spy = createRegistry()
    await register(asRegistry(spy) as never)
    const before = (await spy.rpcs['telegram.status']!({})) as { running: boolean }
    expect(before.running).toBe(true)
    deactivate()
    const after = (await spy.rpcs['telegram.status']!({})) as { running: boolean }
    expect(after.running).toBe(false)
  })
})
