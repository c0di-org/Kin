/** Stand-in for the `cloudflare:workers` module so the worker can be unit-tested under plain vitest. */
export class DurableObject<Env = unknown> {
  constructor(public ctx: any, public env: Env) {}
}
