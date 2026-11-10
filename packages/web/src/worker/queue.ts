/**
 * Planner_Worker 的请求队列。Worker 一次只做一件事；处理每个请求之前先让出事件循环，新消息就能先入队。
 * 取下一个请求时：排队中的 plan 只保留 seq 最大的一个；receipt 的 seq 小于已收到的最大 plan seq 时作废
 * （它对应的补丁已经被编辑过）；其余请求按到达顺序处理。被作废的请求也要回复，让主线程的 Promise 结束。
 */
import type { Request } from "./protocol.ts";

export interface Job {
  readonly id: number;
  readonly req: Request;
}

export class JobQueue {
  #jobs: Job[] = [];
  #latestPlan = -Infinity;

  get size(): number {
    return this.#jobs.length;
  }

  push(job: Job): void {
    if (job.req.type === "plan") this.#latestPlan = Math.max(this.#latestPlan, job.req.seq);
    this.#jobs.push(job);
  }

  /** 下一个要处理的请求，以及这次作废的请求。 */
  take(): { readonly run: Job | undefined; readonly stale: readonly Job[] } {
    const stale: Job[] = [];
    const keep: Job[] = [];
    const lastPlan = this.#jobs.reduce((at, j, i) => (j.req.type === "plan" ? i : at), -1);
    this.#jobs.forEach((j, i) => {
      if (j.req.type === "plan" && i !== lastPlan) stale.push(j);
      else if (j.req.type === "receipt" && j.req.seq < this.#latestPlan) stale.push(j);
      else keep.push(j);
    });
    const [run, ...rest] = keep;
    this.#jobs = rest;
    return { run, stale };
  }
}
