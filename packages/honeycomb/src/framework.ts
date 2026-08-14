/**
 * Minimal Cordis-compatible runtime seam for `@dfh/honeycomb`.
 *
 * Honeycomb is a *concept-level reimplementation* of the multi-agent
 * orchestration model. It does not import the real `@deepseek-ai/cordis`
 * runtime; it declares only the Cordis primitives the honeycomb services
 * consume. The method signatures mirror Cordis (`provide` / `get`, emit
 * events, `waterfall` reduction hooks, `effect` lifecycle), so swapping this
 * module for the real `Context` at integration time is mechanical.
 *
 * Two empty interfaces — {@link Events} and {@link Context} — are the
 * declaration-merging targets: `events.ts` merges the hive emit-map into
 * `Events`, and `context.ts` merges the five services (plus `agents`) into
 * `Context`. This is the same idiom Cordis uses for `ctx.hive`, `ctx.emit`,
 * etc.
 *
 * @module @dfh/honeycomb/framework
 */

/** A disposer returned by lifecycle registrations. */
export type Disposable = () => void

/**
 * Base event map. Honeycomb's emit-style events are merged in via declaration
 * merging in `events.ts`. Each key maps to the *payload object* delivered to
 * listeners.
 */
export interface Events {}

/**
 * Base context interface. Honeycomb's services (`hive`, `ledger`, `courier`,
 * `mandate`, `roster`, `agents`) are merged in via declaration merging in
 * `context.ts`.
 */
export interface Context {}

type Listener = (...args: any[]) => any

/**
 * A minimal, self-contained {@link Context}. Backed by an in-memory service
 * table and event listeners. Supports scoping (`scope()`) and lifecycle
 * disposal (`effect` / `onDispose`).
 */
export class Context {
  protected readonly services = new Map<string, unknown>()
  protected readonly listeners = new Map<string, Listener[]>()
  protected readonly disposers: Disposable[] = []
  protected disposed = false
  readonly parent?: Context

  constructor(parent?: Context) {
    if (parent) this.parent = parent
  }

  // -- services ------------------------------------------------------------

  /**
   * Register a service under `key` (Cordis `provide`).
   *
   * The service is stored in the table *and* set as an own property so the
   * documented `ctx.hive` property access works at runtime (real Cordis uses a
   * Proxy for this; the seam uses a direct property to stay dependency-free).
   */
  provide<K extends keyof Context & string>(key: K, value: Context[K]): void {
    this.services.set(key, value)
    ;(this as unknown as Record<string, unknown>)[key] = value
  }

  /** Read a service, falling back to the parent scope (Cordis `get`). */
  get<K extends keyof Context & string>(key: K): Context[K] {
    const value = this.services.get(key)
    if (value === undefined && this.parent) return this.parent.get(key)
    return value as Context[K]
  }

  /** Inject several services into a callback (Cordis `inject`). */
  inject<K extends (keyof Context & string)[]>(
    keys: [...K],
    callback: (...services: { [I in keyof K]: Context[K[I]] }) => void,
  ): void {
    const services = keys.map((key) => this.get(key))
    callback(...(services as any))
  }

  // -- events --------------------------------------------------------------

  /** Emit-style subscription: listener receives the payload object. */
  on<K extends keyof Events & string>(name: K, listener: (payload: Events[K]) => void): Disposable
  /** Reduction-hook subscription: listener receives `(acc, payload)`. */
  on(name: string, listener: Listener): Disposable
  on(name: string, listener: Listener): Disposable {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
    return () => this.off(name, listener)
  }

  once<K extends keyof Events & string>(name: K, listener: (payload: Events[K]) => void): Disposable {
    const wrapper = (payload: Events[K]): void => {
      this.off(name, wrapper)
      listener(payload)
    }
    return this.on(name, wrapper)
  }

  off(name: string, listener: Listener): void {
    const list = this.listeners.get(name)
    if (!list) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }

  /** Fire an emit-style event. Observer failures are isolated. */
  emit<K extends keyof Events & string>(name: K, payload: Events[K]): void {
    const list = this.listeners.get(name)
    if (!list) return
    for (const listener of [...list]) {
      try {
        listener(payload)
      } catch {
        // observers are isolated: a throwing listener never breaks the chain
      }
    }
  }

  /**
   * Run registered listeners as a reduction (Cordis `waterfall`). Each
   * listener receives `(acc, payload)` and returns the next `acc`
   * (`undefined` leaves `acc` unchanged). Returns the final `acc`.
   */
  waterfall<TAcc, TPayload = unknown>(name: string, acc: TAcc, payload: TPayload): TAcc {
    const list = this.listeners.get(name)
    if (!list) return acc
    let value: unknown = acc
    for (const listener of [...list]) {
      const next = listener(value, payload)
      if (next !== undefined) value = next
    }
    return value as TAcc
  }

  /** Run listeners in order, ignoring return values (Cordis `serial`). */
  serial<TPayload = unknown>(name: string, payload: TPayload): void {
    const list = this.listeners.get(name)
    if (!list) return
    for (const listener of [...list]) {
      try {
        listener(payload)
      } catch {
        // isolated
      }
    }
  }

  /** First truthy return short-circuits (Cordis `bail`). */
  bail<TResult, TPayload = unknown>(name: string, payload: TPayload): TResult | undefined {
    const list = this.listeners.get(name)
    if (!list) return undefined
    for (const listener of [...list]) {
      const result = listener(payload) as TResult | undefined
      if (result) return result
    }
    return undefined
  }

  /** Run listeners in parallel, awaiting all (Cordis `parallel`). */
  async parallel<TPayload = unknown>(name: string, payload: TPayload): Promise<unknown[]> {
    const list = this.listeners.get(name)
    if (!list) return []
    return Promise.all([...list].map((listener) => listener(payload)))
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Register a lazy effect (Cordis `effect`). The callback returns a disposer
   * that runs when this context is disposed.
   */
  effect(callback: () => Disposable | void): void {
    if (this.disposed) return
    let disposer: Disposable | void
    try {
      disposer = callback()
    } catch {
      return
    }
    if (disposer) this.disposers.push(disposer)
  }

  /** Register a disposer (Cordis `onDispose`). */
  onDispose(callback: Disposable): void {
    if (this.disposed) {
      callback()
      return
    }
    this.disposers.push(callback)
  }

  /** The root (top-most) context. */
  get root(): Context {
    return this.parent ? this.parent.root : this
  }

  /** Create a child scope that inherits services and forwards disposal. */
  scope(): Context {
    const child = new Context(this)
    this.onDispose(() => child.dispose())
    return child
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const disposers = this.disposers.splice(0).reverse()
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        // dispose is best-effort
      }
    }
  }
}

// -- generic runtime helpers ------------------------------------------------

let counter = 0

/** Monotonic, collision-resistant id (no platform dependency). */
export function makeId(prefix: string): string {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${counter.toString(36)}_${rand}`
}

/** Current epoch milliseconds. */
export function now(): number {
  return Date.now()
}
