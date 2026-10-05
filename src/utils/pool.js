/** 简单的并发上限映射（避免为一个依赖引入 p-limit） */
export async function mapLimit(items, limit, worker, { onProgress } = {}) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  let done = 0;
  const size = Math.max(1, Math.min(limit || 1, list.length || 1));

  async function runner() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (err) {
        results[index] = { __error: err };
      }
      done += 1;
      onProgress?.(done, list.length);
    }
  }

  await Promise.all(Array.from({ length: size }, runner));
  return results;
}

/** 互斥量：限制同时进行的重任务数量 */
export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  get pending() {
    return this.queue.length;
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    // 槽位在 release() 中直接转移给等待者，期间 active 保持不减
    await new Promise((resolve) => this.queue.push(resolve));
    return () => this.release();
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
