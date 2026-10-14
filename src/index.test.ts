import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { register, deactivate } from './index.js'

interface RegistrySpy {
  hooks: Record<string, (payload: unknown) => unknown>
  rpcs: Record<string, (params: Record<string, unknown>) => unknown>
  settings?: unknown
  /** Ordered log of settings()/registerSettings() calls, to assert wiring order. */
  events: string[]
  context: {
    id: string
    version: string
    runtime: { mode: string; configDirectory: string }
    logger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
    settings: () => Record<string, unknown>
    notify: ReturnType<typeof vi.fn>
  }
}

/**
 * Build a fake host registry. With `gateSettingsOnSchema`, `context.settings()`
 * returns `{}` until `registerSettings` has run — this mirrors the real host
 * (`PluginHost.createContext().settings` looks up the schema before reading
 * values), so a `configure()` that runs before `registerSettings` sees no
 * settings and leaves the bridge unconfigured.
 */
function createRegistry(options: {
  values?: Record<string, unknown>
  gateSettingsOnSchema?: boolean
} = {}): { spy: RegistrySpy; registry: unknown } {
  const { values = {}, gateSettingsOnSchema = false } = options
  let schemaRegistered = false

  const spy: RegistrySpy = {
    hooks: {},
    rpcs: {},
    events: [],
    context: {
      id: 'openfox-telegram',
      version: '1.0.1',
      runtime: { mode: 'production', configDirectory: '/tmp' },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      settings: () => {
        spy.events.push('settings')
        return schemaRegistered || !gateSettingsOnSchema ? values : {}
      },
      notify: vi.fn(),
    },
  }

  const registry = {
    context: spy.context,
    runtime: spy.context.runtime,
    registerHook: (event: string, handler: (payload: unknown) => unknown) => {
      spy.hooks[event] = handler
    },
    registerRpc: (method: string, handler: (params: Record<string, unknown>) => unknown) => {
      spy.rpcs[method] = handler
    },
    registerSettings: (schema: unknown) => {
      spy.events.push('registerSettings')
      schemaRegistered = true
      spy.settings = schema
    },
  }

  return { spy, registry }
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
    const { spy, registry } = createRegistry()
    await register(registry as never)

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
    const { spy, registry } = createRegistry()
    await register(registry as never)
    spy.context.notify.mockClear()

    await expect(spy.rpcs['telegram.test']!({})).rejects.toThrow()

    expect(spy.context.notify).not.toHaveBeenCalled()
    deactivate()
  })

  it('reports an unconfigured status and survives a hook call without config', async () => {
    const { spy, registry } = createRegistry()
    await register(registry as never)

    const status = (await spy.rpcs['telegram.status']!({})) as { configured: boolean; running: boolean }
    expect(status.configured).toBe(false)
    expect(status.running).toBe(true)

    // No bot token configured -> hook must be a no-op, never throw.
    await expect(spy.hooks['turn.completed']!({ sessionId: 's1', data: { reason: 'waiting_for_user' } })).resolves.toBeUndefined()

    await expect(spy.rpcs['telegram.test']!({})).rejects.toThrow()

    deactivate()
  })

  it('stops the bridge on deactivate', async () => {
    const { spy, registry } = createRegistry()
    await register(registry as never)
    const before = (await spy.rpcs['telegram.status']!({})) as { running: boolean }
    expect(before.running).toBe(true)
    deactivate()
    const after = (await spy.rpcs['telegram.status']!({})) as { running: boolean }
    expect(after.running).toBe(false)
  })

  // --- regression: settings must be read after the schema is registered ------

  it('configures the bridge at registration without needing a turn.completed hook', async () => {
    // The host only exposes settings once the plugin has registered its schema.
    const { spy, registry } = createRegistry({
      values: { botToken: 'token', chatId: '100' },
      gateSettingsOnSchema: true,
    })
    await register(registry as never)

    // No hook was triggered: the bridge must already be configured from register().
    const status = (await spy.rpcs['telegram.status']!({})) as { configured: boolean }
    expect(status.configured).toBe(true)

    deactivate()
  })

  it('registers the settings schema before reading settings (root cause)', async () => {
    const { spy, registry } = createRegistry({
      values: { botToken: 'token', chatId: '100' },
      gateSettingsOnSchema: true,
    })
    await register(registry as never)

    const registerIdx = spy.events.indexOf('registerSettings')
    const firstSettingsIdx = spy.events.indexOf('settings')
    expect(registerIdx).toBeGreaterThanOrEqual(0)
    expect(firstSettingsIdx).toBeGreaterThanOrEqual(0)
    // registerSettings must precede the first settings() read, otherwise the
    // bridge reads an empty settings object and never gets configured.
    expect(firstSettingsIdx).toBeGreaterThan(registerIdx)

    deactivate()
  })
})
