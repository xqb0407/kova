import { describe, expect, it, mock } from "bun:test";
import { disposeControllers } from "./disposeControllers";

describe("disposeControllers", () => {
  it("disposes every controller before rethrowing the first error", () => {
    const cleanupError = new Error("first cleanup failed");
    const first = {
      dispose: mock(() => {
        throw cleanupError;
      }),
    };
    const second = { dispose: mock(() => {}) };

    expect(() => disposeControllers([first, second])).toThrow(cleanupError);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });
});
