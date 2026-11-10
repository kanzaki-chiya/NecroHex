/**
 * 主线程这一侧的 Planner_Worker 客户端：给每个请求编号，按编号把响应交回调用方。
 */
import type { Envelope, Request, ResponseBody } from "./protocol.ts";

export interface WorkerLike {
  onmessage: ((e: MessageEvent<Envelope<ResponseBody>>) => void) | null;
  postMessage(message: Envelope<Request>, transfer?: Transferable[]): void;
}

export class PlannerClient {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<number, (body: ResponseBody) => void>();
  #next = 1;

  constructor(worker: WorkerLike) {
    this.#worker = worker;
    worker.onmessage = (e) => {
      const done = this.#pending.get(e.data.id);
      if (!done) return;
      this.#pending.delete(e.data.id);
      done(e.data.body);
    };
  }

  request(body: Request, transfer: Transferable[] = []): Promise<ResponseBody> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#worker.postMessage({ id, body }, transfer);
    });
  }
}

/** 最后一次调用之后 ms 毫秒才执行；flush 立即执行排队中的调用。 */
export function debounce(fn: () => void, ms: number): { (): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = undefined;
    fn();
  };
  const call = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  call.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    run();
  };
  call.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return call;
}
