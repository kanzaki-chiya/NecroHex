/**
 * Planner_Worker 入口：解析、哈希、规划、回执和导出都在这里运行，主线程不调用补丁引擎。
 */
import type { Envelope, Request, ResponseBody } from "./protocol.ts";
import { JobQueue, type Job } from "./queue.ts";
import { Session, SessionError } from "./session.ts";

interface WorkerScope {
  onmessage: ((e: MessageEvent<Envelope<Request>>) => void) | null;
  postMessage(message: Envelope<ResponseBody>, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const session = new Session();
const queue = new JobQueue();
let scheduled = false;

function reply(id: number, body: ResponseBody, transfer: Transferable[] = []): void {
  scope.postMessage({ id, body }, transfer);
}

function handle(job: Job): void {
  const { id, req } = job;
  try {
    switch (req.type) {
      case "open":
        return reply(id, { type: "open", summary: session.open(req.name, req.bytes, req.sample) });
      case "map": {
        const map = session.mapData(req.scope);
        return reply(id, { type: "map", map });
      }
      case "plan":
        return reply(id, { type: "plan", plan: session.plan(req.seq, req.patch, req.scope) });
      case "status":
        return reply(id, { type: "status", ok: session.status(req.patches) });
      case "receipt":
        return reply(id, { type: "receipt", receipt: session.receipt(req.seq, req.patch) });
      case "export": {
        const result = session.export(req.patch);
        return reply(id, { type: "export", result }, result.ok ? [result.pwad.buffer as ArrayBuffer] : []);
      }
    }
  } catch (e) {
    const code = e instanceof SessionError ? e.code : "INTERNAL";
    reply(id, { type: "error", code, message: e instanceof Error ? e.message : String(e) });
  }
}

function drain(): void {
  scheduled = false;
  const { run, stale } = queue.take();
  for (const j of stale) reply(j.id, { type: "stale" });
  if (run) handle(run);
  if (queue.size > 0) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  // 让出事件循环，处理期间到达的消息先入队，再决定下一个做什么
  setTimeout(drain, 0);
}

scope.onmessage = (e) => {
  queue.push({ id: e.data.id, req: e.data.body });
  schedule();
};
