/**
 * run_design_script 的执行核：把 agent 写的一段 JS 放进独立 worker 跑，只收「操作录」。
 *
 * 为什么要有 worker：脚本是 agent 现写的，最现实的事故是死循环或爆内存。
 * worker 让这两件事可以用 terminate() 硬中断——在 MCP server 主线程里 eval 是做不到的
 * （会连同 server 一起卡死，没有任何超时能救）。
 *
 * 能力边界（如实说明）：eval worker 隔离的是**事件循环**，不是模块系统——bun 的 eval worker
 * 里 require 仍然可用。因此这里把 require/process/fetch/Buffer 以抛错桩的形式作为形参注入，
 * 覆盖脚本里最常见的几条逃逸路径；动态 import() 这类冷门路径不在覆盖范围内。
 * 真正的信任边界是「脚本由 agent 写、且 agent 本来就有同等的文件与命令权限」。
 *
 * 脚本不直接改文档：它只往操作录里追加 I()/U()/log()，主线程拿到后走 add_nodes /
 * update_nodes 的同一套 specToNode + apply 代码落盘，保证产物与直接调工具逐字节同构。
 */
import { Worker } from "node:worker_threads";

export type ScriptOp =
  | { kind: "insert"; parent: string; spec: Record<string, unknown> }
  | { kind: "update"; id: string; patch: Record<string, unknown> };

export type ScriptResult = {
  ops: ScriptOp[];
  logs: string[];
  /** 脚本自身的返回值（JSON 可序列化时透传） */
  result: unknown;
};

export const SCRIPT_TIMEOUT_DEFAULT = 5000;
export const SCRIPT_TIMEOUT_MIN = 500;
export const SCRIPT_TIMEOUT_MAX = 30000;
export const SCRIPT_MAX_OPS = 2000;

/** worker 引导代码：注入 I/U/log 记录器 + 逃逸桩，跑完把操作录 postMessage 回来 */
const BOOTSTRAP = `
const { workerData, parentPort } = require("node:worker_threads");
const ops = [];
const logs = [];
let seq = 0;

const I = (parent, spec) => {
  if (typeof parent !== "string" || !parent) throw new Error("I(parentId, spec)：parentId 必须是非空字符串");
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("I(parentId, spec)：spec 必须是节点规格对象");
  const id = typeof spec.id === "string" && spec.id ? spec.id : "s" + (++seq);
  ops.push({ kind: "insert", parent, spec: Object.assign({}, spec, { id }) });
  return id;
};
const U = (id, patch) => {
  if (typeof id !== "string" || !id) throw new Error("U(nodeId, patch)：nodeId 必须是非空字符串");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("U(nodeId, patch)：patch 必须是字段对象");
  ops.push({ kind: "update", id, patch });
  return id;
};
const log = (...args) => { logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };

// 逃逸桩用 Proxy：任何属性访问（process.exit）、调用（require("fs")）、构造（new Buffer）
// 都直接抛出点名道姓的错误，而不是让脚本撞上一个 undefined 再报些看不懂的 TypeError。
const blocked = (what) => new Proxy(function () {}, {
  get(_t, prop) { throw new Error("run_design_script 沙箱禁用 " + what + "." + String(prop) + "：脚本只做纯计算，操作一律用 I()/U() 记录"); },
  apply() { throw new Error("run_design_script 沙箱禁用 " + what + "()：脚本只做纯计算，操作一律用 I()/U() 记录"); },
  construct() { throw new Error("run_design_script 沙箱禁用 new " + what + "()：脚本只做纯计算，操作一律用 I()/U() 记录"); },
});
const sandbox = {
  require: blocked("require"),
  process: blocked("process"),
  fetch: blocked("fetch"),
  Buffer: blocked("Buffer"),
};

let result = null;
let failure = null;
try {
  const fn = new Function("I", "U", "log", "require", "process", "fetch", "Buffer", workerData.script);
  const r = fn(I, U, log, sandbox.require, sandbox.process, sandbox.fetch, sandbox.Buffer);
  result = r === undefined ? null : r;
} catch (err) {
  failure = String((err && err.stack) || err);
}
parentPort.postMessage({ ok: failure === null, error: failure, ops, logs, result });
`;

/**
 * 在 worker 里跑脚本并收回操作录。
 * 超时/崩溃/语法错误都抛可读 Error——主线程只见到异常，不会见到挂死的 worker。
 */
export function runDesignScript(script: string, timeoutMs?: number): Promise<ScriptResult> {
  if (typeof script !== "string" || !script.trim()) {
    return Promise.reject(new Error("script 必填：一段 JS 源码（可用 I()/U()/log()，可 return）"));
  }
  const ms = Math.min(SCRIPT_TIMEOUT_MAX, Math.max(SCRIPT_TIMEOUT_MIN, timeoutMs ?? SCRIPT_TIMEOUT_DEFAULT));

  return new Promise<ScriptResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(BOOTSTRAP, { eval: true, workerData: { script } });
    } catch (err) {
      reject(
        new Error(
          `无法创建脚本沙箱 worker：${err instanceof Error ? err.message : String(err)}` +
            "；请改用 add_nodes / update_nodes 显式铺开节点。",
        ),
      );
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `脚本执行超过 ${ms}ms 已被强制中断（多半是死循环）。` +
              "请检查循环条件，或拆成多次调用；也可以调大 timeoutMs（上限 30000）。",
          ),
        ),
      );
    }, ms);

    worker.on("message", (msg: { ok?: boolean; error?: string; ops?: ScriptOp[]; logs?: string[]; result?: unknown }) => {
      finish(() => {
        if (!msg?.ok) {
          reject(new Error(`脚本报错：${msg?.error ?? "未知错误"}`));
          return;
        }
        const ops = msg.ops ?? [];
        if (ops.length > SCRIPT_MAX_OPS) {
          reject(new Error(`脚本产生了 ${ops.length} 个操作，超过上限 ${SCRIPT_MAX_OPS}；请拆成多次调用`));
          return;
        }
        resolve({ ops, logs: msg.logs ?? [], result: msg.result ?? null });
      });
    });

    worker.on("error", (err) => {
      finish(() =>
        reject(
          new Error(
            `脚本沙箱异常：${err instanceof Error ? err.message : String(err)}` +
              "；请改用 add_nodes / update_nodes 显式铺开节点。",
          ),
        ),
      );
    });

    worker.on("exit", (code) => {
      finish(() => reject(new Error(`脚本沙箱意外退出（code ${code}）；请检查脚本是否调用了 process.exit 之类的方法`)));
    });
  });
}