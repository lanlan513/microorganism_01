/**
 * 时间片工具：跟不上 60fps 时把重活切成小块，块间用 MessageChannel 让出主线程，
 * 绝不阻塞绘制帧（不使用长任务的 setTimeout 下限，MessageChannel 为 0ms 宏任务）。
 */

const channel: MessageChannel | null =
  typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;

/** 让出主线程一帧（下一个宏任务）。 */
export function yieldToHost(): Promise<void> {
  if (!channel) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const { port1, port2 } = channel;
    port1.onmessage = () => {
      port1.onmessage = null;
      resolve();
    };
    port2.postMessage(null);
  });
}

/**
 * 把 [0..total) 的区间切成预算内的小片顺序执行；
 * 每片耗时超过 frameBudgetMs 就让出主线程，返回 Promise 在全部完成后 resolve。
 * 纯客户端渲染调度，不触碰任何模拟数值。
 */
export async function timeSlice(
  total: number,
  frameBudgetMs: number,
  fn: (from: number, to: number) => void,
  shouldAbort?: () => boolean
): Promise<void> {
  if (total <= 0) return;
  // 目标：单块处理量先粗估 250，按预算自适应
  let chunk = 250;
  let i = 0;
  while (i < total) {
    if (shouldAbort?.()) return;
    const t0 = performance.now();
    const end = Math.min(total, i + chunk);
    fn(i, end);
    const dt = performance.now() - t0;
    i = end;
    if (i < total) {
      if (dt > frameBudgetMs * 0.6) {
        // 本块已吃掉较多预算，先让出
        await yieldToHost();
        // 自适应：把下块调小到能落在预算内
        if (dt > 0) chunk = Math.max(48, Math.floor((chunk * frameBudgetMs * 0.6) / dt));
      }
    }
  }
}

/** 简单的滚动 FPS 统计。 */
export class FpsMeter {
  private frames = 0;
  private last = performance.now();
  fps = 60;
  tick(): number {
    this.frames++;
    const now = performance.now();
    const dt = now - this.last;
    if (dt >= 500) {
      this.fps = Math.round((this.frames * 1000) / dt);
      this.frames = 0;
      this.last = now;
    }
    return this.fps;
  }
}
