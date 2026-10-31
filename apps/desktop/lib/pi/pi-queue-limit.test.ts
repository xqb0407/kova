import { describe, expect, it } from "bun:test";
import { PROMPT_QUEUE_LIMIT } from "pi-protocol";
import { queueSendBlocked } from "./pi-queue-limit";

describe("queueSendBlocked 发送前队列容量守卫", () => {
  it("排队未满放行（哪怕会进排队车道）", () => {
    expect(queueSendBlocked(true, PROMPT_QUEUE_LIMIT - 1)).toBe(false);
    expect(queueSendBlocked(true, 0)).toBe(false);
  });

  it("排队已满且会进排队车道：拦截", () => {
    expect(queueSendBlocked(true, PROMPT_QUEUE_LIMIT)).toBe(true);
    expect(queueSendBlocked(true, PROMPT_QUEUE_LIMIT + 3)).toBe(true);
  });

  it("不会进排队车道（空闲且队列为空）不拦截", () => {
    expect(queueSendBlocked(false, PROMPT_QUEUE_LIMIT)).toBe(false);
  });
});
