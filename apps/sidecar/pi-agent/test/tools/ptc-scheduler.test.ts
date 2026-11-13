import { describe, expect, test } from "bun:test";
import { PtcScheduler } from "../../src/tools/ptc/scheduler";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("PtcScheduler", () => {
  test("parallel calls overlap up to the limit", async () => {
    const scheduler = new PtcScheduler(2);
    let active = 0;
    let maxActive = 0;
    const job = (ms: number) =>
      scheduler.run("parallel", async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick(ms);
        active--;
      });

    await Promise.all([job(20), job(20), job(20), job(20)]);
    expect(maxActive).toBe(2);
  });

  test("a sequential call waits for running parallel calls and runs alone", async () => {
    const scheduler = new PtcScheduler(2);
    const events: string[] = [];
    const parallel = scheduler.run("parallel", async () => {
      events.push("parallel:start");
      await tick(20);
      events.push("parallel:end");
    });
    const sequential = scheduler.run("sequential", async () => {
      events.push("sequential:start");
      await tick(5);
      events.push("sequential:end");
    });
    const after = scheduler.run("parallel", async () => {
      events.push("after:start");
      await tick(5);
      events.push("after:end");
    });

    await Promise.all([parallel, sequential, after]);
    expect(events).toEqual([
      "parallel:start",
      "parallel:end",
      "sequential:start",
      "sequential:end",
      "after:start",
      "after:end",
    ]);
  });

  test("queue order is FIFO across modes", async () => {
    const scheduler = new PtcScheduler(1);
    const events: string[] = [];
    const first = scheduler.run("parallel", async () => {
      events.push("first");
      await tick(10);
    });
    const second = scheduler.run("parallel", async () => {
      events.push("second");
    });
    const third = scheduler.run("sequential", async () => {
      events.push("third");
    });

    await Promise.all([first, second, third]);
    expect(events).toEqual(["first", "second", "third"]);
  });
});
