type RedisValue = string | number;

interface StoredEntry {
  value: RedisValue;
  expiresAt: number | null;
}

type Operation =
  | { type: 'set'; key: string; value: RedisValue; options?: { ex?: number; nx?: boolean } }
  | { type: 'lpush'; key: string; values: string[] }
  | { type: 'incr'; key: string }
  | { type: 'expire'; key: string; seconds: number }
  | { type: 'lrem'; key: string; count: number; value: string }
  | { type: 'del'; key: string };

function cloneStore(source: Map<string, StoredEntry>): Map<string, StoredEntry> {
  return new Map(Array.from(source.entries(), ([key, entry]) => [key, { ...entry }]));
}

function cloneLists(source: Map<string, string[]>): Map<string, string[]> {
  return new Map(Array.from(source.entries(), ([key, values]) => [key, [...values]]));
}

export class RedisTestClient {
  private store = new Map<string, StoredEntry>();
  private lists = new Map<string, string[]>();
  private nextExecError: Error | null = null;

  private purgeExpiredKey(key: string): void {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }

  private applySet(
    targetStore: Map<string, StoredEntry>,
    key: string,
    value: RedisValue,
    options?: { ex?: number; nx?: boolean }
  ): string | null {
    const existing = targetStore.get(key);
    if (options?.nx === true && existing !== undefined) {
      return null;
    }

    targetStore.set(key, {
      value,
      expiresAt: typeof options?.ex === 'number' ? Date.now() + options.ex * 1000 : null
    });
    return 'OK';
  }

  private applyLpush(targetLists: Map<string, string[]>, key: string, values: string[]): number {
    const current = targetLists.get(key) ?? [];
    targetLists.set(key, [...values, ...current]);
    return targetLists.get(key)?.length ?? 0;
  }

  private applyIncr(targetStore: Map<string, StoredEntry>, key: string): number {
    const existing = targetStore.get(key);
    const currentValue = existing ? Number(existing.value) : 0;
    const nextValue = currentValue + 1;
    targetStore.set(key, {
      value: nextValue,
      expiresAt: existing?.expiresAt ?? null
    });
    return nextValue;
  }

  private applyExpire(targetStore: Map<string, StoredEntry>, key: string, seconds: number): 0 | 1 {
    const existing = targetStore.get(key);
    if (!existing) {
      return 0;
    }

    targetStore.set(key, {
      ...existing,
      expiresAt: Date.now() + seconds * 1000
    });
    return 1;
  }

  private applyLrem(targetLists: Map<string, string[]>, key: string, count: number, value: string): number {
    const current = [...(targetLists.get(key) ?? [])];
    let removed = 0;
    const next: string[] = [];

    for (const item of current) {
      if (item === value && (count === 0 || removed < count)) {
        removed += 1;
        continue;
      }
      next.push(item);
    }

    targetLists.set(key, next);
    return removed;
  }

  private applyDel(targetStore: Map<string, StoredEntry>, key: string): number {
    const existed = targetStore.delete(key);
    return existed ? 1 : 0;
  }

  private executeOperation(
    operation: Operation,
    targetStore: Map<string, StoredEntry>,
    targetLists: Map<string, string[]>
  ): unknown {
    switch (operation.type) {
      case 'set':
        return this.applySet(targetStore, operation.key, operation.value, operation.options);
      case 'lpush':
        return this.applyLpush(targetLists, operation.key, operation.values);
      case 'incr':
        return this.applyIncr(targetStore, operation.key);
      case 'expire':
        return this.applyExpire(targetStore, operation.key, operation.seconds);
      case 'lrem':
        return this.applyLrem(targetLists, operation.key, operation.count, operation.value);
      case 'del':
        return this.applyDel(targetStore, operation.key);
    }
  }

  failNextExecWith(error: Error): void {
    this.nextExecError = error;
  }

  async get(key: string): Promise<RedisValue | null> {
    this.purgeExpiredKey(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: RedisValue, options?: { ex?: number; nx?: boolean }): Promise<string | null> {
    this.purgeExpiredKey(key);
    return this.applySet(this.store, key, value, options);
  }

  async del(key: string): Promise<number> {
    return this.applyDel(this.store, key);
  }

  async incr(key: string): Promise<number> {
    this.purgeExpiredKey(key);
    return this.applyIncr(this.store, key);
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    this.purgeExpiredKey(key);
    return this.applyExpire(this.store, key, seconds);
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.applyLpush(this.lists, key, values);
  }

  async rpop(key: string): Promise<string | null> {
    const current = this.lists.get(key) ?? [];
    const value = current.pop() ?? null;
    this.lists.set(key, current);
    return value;
  }

  async lrange(key: string, start: number, end: number): Promise<string[]> {
    const current = this.lists.get(key) ?? [];
    const normalizedEnd = end < 0 ? current.length + end : end;
    return current.slice(start, normalizedEnd + 1);
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    return this.applyLrem(this.lists, key, count, value);
  }

  async llen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }

  async ttl(key: string): Promise<number> {
    this.purgeExpiredKey(key);
    const entry = this.store.get(key);
    if (!entry) {
      return -2;
    }
    if (entry.expiresAt === null) {
      return -1;
    }
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async pttl(key: string): Promise<number> {
    this.purgeExpiredKey(key);
    const entry = this.store.get(key);
    if (!entry) {
      return -2;
    }
    if (entry.expiresAt === null) {
      return -1;
    }
    return Math.max(0, entry.expiresAt - Date.now());
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script.includes('INCR') && script.includes('PEXPIRE') && script.includes('PTTL')) {
      const [key] = keys;
      const [windowMsArg] = args;
      const windowMs = Number.parseInt(windowMsArg, 10);
      const count = await this.incr(key);
      if (count === 1) {
        this.store.set(key, {
          value: count,
          expiresAt: Date.now() + windowMs
        });
      }
      const ttl = await this.pttl(key);
      return [count, ttl];
    }

    if (script.includes('RPOP') && script.includes('LPUSH')) {
      const jobId = await this.rpop(keys[0]);
      if (jobId === null) {
        return null;
      }
      await this.lpush(keys[1], jobId);
      return jobId;
    }

    if (script.includes('EXPIRE')) {
      const [key] = keys;
      const [ownerId, ttl] = args;
      const currentOwner = await this.get(key);
      if (currentOwner !== ownerId) {
        return 0;
      }
      await this.set(key, ownerId, { ex: Number.parseInt(ttl, 10) });
      return 1;
    }

    if (script.includes('DEL')) {
      const [key] = keys;
      const [ownerId] = args;
      const currentOwner = await this.get(key);
      if (currentOwner !== ownerId) {
        return 0;
      }
      await this.del(key);
      return 1;
    }

    throw new Error(`Unsupported eval script in RedisTestClient: ${script}`);
  }

  multi() {
    const operations: Operation[] = [];

    return {
      set: (key: string, value: RedisValue, options?: { ex?: number; nx?: boolean }) => {
        operations.push({ type: 'set', key, value, options });
        return this.multiResult(operations);
      },
      lpush: (key: string, ...values: string[]) => {
        operations.push({ type: 'lpush', key, values });
        return this.multiResult(operations);
      },
      incr: (key: string) => {
        operations.push({ type: 'incr', key });
        return this.multiResult(operations);
      },
      expire: (key: string, seconds: number) => {
        operations.push({ type: 'expire', key, seconds });
        return this.multiResult(operations);
      },
      lrem: (key: string, count: number, value: string) => {
        operations.push({ type: 'lrem', key, count, value });
        return this.multiResult(operations);
      },
      del: (key: string) => {
        operations.push({ type: 'del', key });
        return this.multiResult(operations);
      },
      exec: async (): Promise<unknown[]> => {
        if (this.nextExecError !== null) {
          const error = this.nextExecError;
          this.nextExecError = null;
          throw error;
        }

        const storeClone = cloneStore(this.store);
        const listsClone = cloneLists(this.lists);
        const results: unknown[] = [];

        for (const operation of operations) {
          results.push(this.executeOperation(operation, storeClone, listsClone));
        }

        this.store = storeClone;
        this.lists = listsClone;
        return results;
      }
    };
  }

  private multiResult(operations: Operation[]) {
    return {
      set: (key: string, value: RedisValue, options?: { ex?: number; nx?: boolean }) => {
        operations.push({ type: 'set', key, value, options });
        return this.multiResult(operations);
      },
      lpush: (key: string, ...values: string[]) => {
        operations.push({ type: 'lpush', key, values });
        return this.multiResult(operations);
      },
      incr: (key: string) => {
        operations.push({ type: 'incr', key });
        return this.multiResult(operations);
      },
      expire: (key: string, seconds: number) => {
        operations.push({ type: 'expire', key, seconds });
        return this.multiResult(operations);
      },
      lrem: (key: string, count: number, value: string) => {
        operations.push({ type: 'lrem', key, count, value });
        return this.multiResult(operations);
      },
      del: (key: string) => {
        operations.push({ type: 'del', key });
        return this.multiResult(operations);
      },
      exec: async (): Promise<unknown[]> => {
        if (this.nextExecError !== null) {
          const error = this.nextExecError;
          this.nextExecError = null;
          throw error;
        }

        const storeClone = cloneStore(this.store);
        const listsClone = cloneLists(this.lists);
        const results: unknown[] = [];

        for (const operation of operations) {
          results.push(this.executeOperation(operation, storeClone, listsClone));
        }

        this.store = storeClone;
        this.lists = listsClone;
        return results;
      }
    };
  }

  reset(): void {
    this.store.clear();
    this.lists.clear();
    this.nextExecError = null;
  }

  pipeline() {
    return this.multi();
  }
}

export function createRedisTestClient(): RedisTestClient {
  return new RedisTestClient();
}
