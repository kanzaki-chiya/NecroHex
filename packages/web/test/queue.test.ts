import { describe, expect, it } from "vitest";
import { JobQueue } from "../src/worker/queue.ts";
import type { Request } from "../src/worker/protocol.ts";

const plan = (seq: number): Request => ({ type: "plan", seq, patch: {}, scope: "MAP01" });
const receipt = (seq: number): Request => ({ type: "receipt", seq, patch: {} });

describe("JobQueue", () => {
  it("排队中的 plan 只处理 seq 最大的一个，其余作废", () => {
    const q = new JobQueue();
    [plan(1), plan(2), plan(3)].forEach((req, i) => q.push({ id: i + 1, req }));
    const t = q.take();
    expect(t.run?.id).toBe(3);
    expect(t.stale.map((j) => j.id)).toEqual([1, 2]);
    expect(q.size).toBe(0);
  });

  it("receipt 的 seq 小于已收到的 plan 时作废，等于时保留", () => {
    const q = new JobQueue();
    q.push({ id: 1, req: plan(4) });
    expect(q.take().run?.id).toBe(1);
    q.push({ id: 2, req: receipt(4) });
    expect(q.take().run?.id).toBe(2);
    q.push({ id: 3, req: receipt(4) });
    q.push({ id: 4, req: plan(5) });
    const t = q.take();
    expect(t.stale.map((j) => j.id)).toEqual([3]);
    expect(t.run?.id).toBe(4);
  });

  it("其他请求按到达顺序处理，不被合并", () => {
    const q = new JobQueue();
    q.push({ id: 1, req: { type: "map", scope: "MAP01" } });
    q.push({ id: 2, req: plan(1) });
    q.push({ id: 3, req: { type: "export", patch: {} } });
    q.push({ id: 4, req: { type: "status", patches: [] } });
    const order: number[] = [];
    for (let t = q.take(); t.run; t = q.take()) order.push(t.run.id);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
