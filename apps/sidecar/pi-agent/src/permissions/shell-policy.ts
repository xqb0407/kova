/**
 * Shell 操作策略：把 bash 命令分成“查看 / 验证 / 命令自身写 / 手工改 / 动态”。
 *
 * 目的不是禁 bash，而是保证：
 * - Plan / Goal 协商期只放行查看和验证；
 * - Agent 正常轮不允许用 shell 手写项目文件，手工编辑必须走 write/edit，
 *   这样逐文件 checkpoint/diff 才成立；
 * - formatter / codegen / 测试 / 构建等“命令本身负责写”的操作保留。
 *
 * 语法解析用 tree-sitter-bash；策略、命令白名单与错误处理由 Kova 自己维护。
 * 解析器不可用时退回保守扫描器：仍能识别 sed -i/重定向/heredoc 等高信号形态，
 * 其余归 dynamic，不静默放行。
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import bashGrammarPath from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };
import treeSitterWasmPath from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import { logErr } from "../log";

export type ShellOperationClass =
  | "inspect"
  | "verify"
  | "managed-write"
  | "inline-edit"
  | "dynamic";

export type ShellPolicyContext = {
  cwd?: string;
  /** 项目根：主工作区 + 项目附加根 */
  roots?: readonly string[];
  /** 允许写临时产物的目录；落到这里不按项目手写处理 */
  tempRoots?: readonly string[];
};

const RANK: Record<ShellOperationClass, number> = {
  inspect: 0,
  verify: 1,
  "managed-write": 2,
  dynamic: 3,
  "inline-edit": 4,
};

let parser: Parser | null = null;
let initPromise: Promise<void> | undefined;

/** 启动闸门内调一次；失败只记日志，分类退回保守扫描器。 */
export function initShellPolicy(): Promise<void> {
  initPromise ??= (async () => {
    try {
      const runtime = readFileSync(treeSitterWasmPath);
      await Parser.init({ wasmBinary: runtime } as never);
      const language = await Language.load(readFileSync(bashGrammarPath));
      const next = new Parser();
      next.setLanguage(language);
      parser = next;
    } catch (err) {
      logErr(
        "shell-policy: parser init failed, using conservative fallback:",
        err instanceof Error ? err.message : String(err),
      );
      parser = null;
    }
    if (!parser && process.env.PI_SHELL_POLICY_SELFTEST === "1") {
      throw new Error("shell-policy: parser unavailable (WASM asset missing)");
    }
  })();
  return initPromise;
}

/** 测试辅助：清空解析器与初始化缓存 */
export function resetShellPolicyForTest(): void {
  parser = null;
  initPromise = undefined;
}

function worse(a: ShellOperationClass, b: ShellOperationClass): ShellOperationClass {
  return RANK[a] >= RANK[b] ? a : b;
}

/** 命令分类（同步）：parser 就绪时走语法树，否则退回快扫。 */
export function classifyShellCommand(
  command: string,
  context: ShellPolicyContext = {},
): ShellOperationClass {
  const text = command.trim();
  if (!text) return "dynamic";
  if (!parser) return classifyFallback(text, context);
  try {
    const tree = parser.parse(text);
    if (!tree) return classifyFallback(text, context);
    try {
      return classifyNode(tree.rootNode, context);
    } finally {
      tree.delete();
    }
  } catch (err) {
    logErr(
      "shell-policy: parse failed, using conservative fallback:",
      err instanceof Error ? err.message : String(err),
    );
    return classifyFallback(text, context);
  }
}

/* ------------------------------- AST 遍历 ------------------------------- */

function classifyNode(node: SyntaxNode, context: ShellPolicyContext): ShellOperationClass {
  switch (node.type) {
    case "program":
      return mergeChildren(node, context);
    case "command":
      return classifyCommandNode(node, context);
    case "redirected_statement": {
      const body = node.childForFieldName("body");
      let out: ShellOperationClass = body ? classifyNode(body, context) : "inspect";
      for (const redirect of node.childrenForFieldName("redirect")) {
        out = worse(out, classifyRedirect(redirect, context));
      }
      return out;
    }
    case "file_redirect":
      return classifyRedirect(node, context);
    case "heredoc_redirect":
    case "herestring_redirect":
      return mergeChildren(node, context, "inspect");
    case "pipeline":
    case "list":
      return mergeChildren(node, context);
    case "command_substitution":
    case "process_substitution": {
      const inner = mergeChildren(node, context, "inspect");
      return inner === "inline-edit" ? inner : worse(inner, "dynamic");
    }
    case "subshell":
    case "compound_statement":
    case "for_statement":
    case "c_for_statement":
    case "while_statement":
    case "if_statement":
    case "case_statement":
    case "function_definition": {
      const inner = mergeChildren(node, context, "inspect");
      return inner === "inline-edit" ? inner : worse(inner, "dynamic");
    }
    case "variable_assignment":
      // 赋值本身不写盘，但右侧可能是 $(sed -i ...) / $(touch ...)。
      return mergeChildren(node, context, "inspect");
    case "expansion":
    case "simple_expansion":
    case "arithmetic_expansion":
      return "inspect";
    case "comment":
      return "inspect";
    default:
      return mergeChildren(node, context, "inspect");
  }
}

function mergeChildren(
  node: SyntaxNode,
  context: ShellPolicyContext,
  initial: ShellOperationClass = "inspect",
): ShellOperationClass {
  let out = initial;
  for (const child of node.namedChildren) {
    if (child.type === "comment") continue;
    out = worse(out, classifyNode(child, context));
    // inline-edit 已经是最坏分类，后面不可能再升级，提前收工。
    if (out === "inline-edit") return out;
  }
  return out;
}

function classifyCommandNode(
  node: SyntaxNode,
  context: ShellPolicyContext,
): ShellOperationClass {
  const nameNode = node.childForFieldName("name");
  const name = nameNode ? unquote(nameNode.text).trim() : "";
  if (!name) return "dynamic";
  const args = node
    .childrenForFieldName("argument")
    .map((arg) => unquote(arg.text).trim())
    .filter(Boolean);
  let out = classifyCommand(name, args, context);
  // 参数、重定向、引号里的 $(...) 都可能藏写入；逐个 named child 走一遍。
  // 这里只遍历 children，不会再进 command 自己，因此不会递归成环。
  for (const child of node.namedChildren) {
    out = worse(out, classifyNode(child, context));
    if (out === "inline-edit") return out;
  }
  return out;
}

function classifyRedirect(
  node: SyntaxNode,
  context: ShellPolicyContext,
): ShellOperationClass {
  if (node.type === "heredoc_redirect" || node.type === "herestring_redirect") {
    return mergeChildren(node, context, "inspect");
  }
  if (node.type !== "file_redirect") return mergeChildren(node, context, "inspect");
  const text = unquote(node.text).trim();
  const destNode = node.childForFieldName("destination");
  const dest = destNode ? unquote(destNode.text).trim() : "";
  // 输入重定向（< file）不写盘；2>&1 这类 fd 复制也不是文件写入。
  if (!text.includes(">")) return "inspect";
  if (!dest || dest.startsWith("&")) return "inspect";
  if (dest === "/dev/null" || dest === "/dev/stdout" || dest === "/dev/stderr") {
    return "inspect";
  }
  const target = resolveTarget(dest, context);
  if (!target) return "dynamic";
  // 项目根优先于临时根：测试/任务工作区本身可能就在 /tmp 下。
  if (isProjectTarget(target, context)) return "inline-edit";
  if (isTempTarget(target, context)) return "inspect";
  return "managed-write";
}

/* ------------------------------ 命令分类 ------------------------------ */

function classifyCommand(
  rawName: string,
  args: string[],
  context: ShellPolicyContext,
): ShellOperationClass {
  const name = basename(rawName);
  if (!name) return "dynamic";

  // 包装器：继续看内部真正执行的命令。
  if (isShellWrapper(name)) {
    const idx = args.findIndex(
      (arg) => arg === "-c" || arg === "--command" || /^-[a-zA-Z]*c$/.test(arg),
    );
    if (idx >= 0 && args[idx + 1]) {
      return classifyShellCommand(args[idx + 1], context);
    }
    return "dynamic";
  }
  if (name === "command") {
    // `command -v git` 只是查找；`command git ...` 才继续分类内部命令。
    if (args.some((arg) => arg === "-v" || arg === "-V")) return "inspect";
    // command 的 -p 不取值（用默认 PATH 查找），不能按通用 wrapper 的带值 flag 跳过下一个 token
    const rest = args.filter((arg) => arg !== "-p" && arg !== "--");
    return rest.length ? classifyShellCommand(rest.join(" "), context) : "inspect";
  }
  if (name === "env" || name === "builtin" || name === "nohup" || name === "exec") {
    const rest = stripWrapperOptions(args);
    return rest.length ? classifyShellCommand(rest.join(" "), context) : "dynamic";
  }
  if (name === "sudo" || name === "doas") {
    const rest = stripWrapperOptions(args);
    return rest.length ? classifyShellCommand(rest.join(" "), context) : "dynamic";
  }
  if (name === "xargs") {
    // xargs 后面的真正命令才决定它会不会手写文件。
    const rest = stripWrapperOptions(args, new Set(["-I", "-L", "-n", "-P", "-s", "-E"]));
    if (!rest.length) return "dynamic";
    const inner = classifyCommand(rest[0]!, rest.slice(1), context);
    return inner === "inline-edit" ? "inline-edit" : "managed-write";
  }
  if (name === "npx" || name === "pnpx" || name === "bunx") {
    const rest = stripWrapperOptions(args, new Set(["--package", "-p"]));
    return rest.length ? classifyShellCommand(rest.join(" "), context) : "dynamic";
  }

  switch (name) {
    case "sed": {
      if (args.some(isSedInPlace)) return "inline-edit";
      // sed 的 w/W 命令会写文件，e 会执行 shell；它们在 -i 之外也是写入通道。
      const script = args.join(" ");
      if (/(?:^|[;\n\s]|\d|\/)[wWe]\s+\S/.test(script)) return "inline-edit";
      // -f 指向磁盘上的脚本文件，里面的 w 命令命令行上看不见。
      if (args.some(isFileScriptFlag)) return "dynamic";
      return "inspect";
    }
    case "perl": {
      if (args.some(isPerlInPlace)) return "inline-edit";
      if (args.some((arg) => /^-[a-zA-Z]*[eE]$/.test(arg))) {
        return args.some((arg) =>
          /\b(?:open|system|unlink|rename|mkdir|chmod)\b/.test(arg),
        )
          ? "inline-edit"
          : "dynamic";
      }
      // 只有版本/帮助可静态确认为只读；脚本文件或从 stdin 读程序都不可见。
      return args.some((arg) => arg === "--version" || arg === "-v" || arg === "-h")
        ? "inspect"
        : "dynamic";
    }
    case "awk":
    case "gawk": {
      const script = args.join(" ");
      if (/\bsystem\s*\(|\b(?:print|printf)\b[^;\n]*>/.test(script)) {
        return "inline-edit";
      }
      // `-i inplace` 是唯一安全的 -i 用法；其余 -i/--include/-l/--load
      // 都会从磁盘加载可执行代码，内容不可见。
      if (isAwkInplace(args)) return "inline-edit";
      if (isAwkCodeLoading(args)) return "dynamic";
      // "cmd" | getline、|& 协进程、print | "cmd" 都是真执行外部命令。
      if (/["']\s*\|&?\s*|\|\s*&?\s*(?:["']|getline)/.test(script)) return "dynamic";
      // -f 的脚本文件与 stdin 程序都不可见，无法静态判断。
      if (args.some(isFileScriptFlag)) return "dynamic";
      if (!args.some((arg) => !arg.startsWith("-"))) return "dynamic";
      return "inspect";
    }
    case "tee":
    case "patch":
    case "dd":
    case "truncate":
      return "inline-edit";
    case "find": {
      const execClass = classifyFindExecs(args, context);
      if (execClass) return execClass;
      return args.includes("-delete") ? "managed-write" : "inspect";
    }
    case "cp":
    case "mv":
    case "rm":
    case "rmdir":
    case "mkdir":
    case "touch":
    case "ln":
    case "install":
    case "rsync":
    case "chmod":
    case "chown":
    case "chgrp":
      return "managed-write";
    case "git":
      return classifyGit(args);
    case "pnpm":
    case "npm":
    case "yarn":
    case "bun":
      return classifyPackageManager(name, args, context);
    case "cargo":
      return classifyCargo(args);
    case "go":
      return classifyGo(args);
    case "pip":
    case "pip3":
    case "poetry":
    case "uv":
      return args.some((arg) => /^(?:install|add|remove|uninstall|update|sync|lock)$/.test(arg))
        ? "managed-write"
        : "verify";
    case "deno":
      return args.some((arg) => /^(?:install|add|remove|uninstall|update)$/.test(arg))
        ? "managed-write"
        : "verify";
    case "prettier":
      return args.some((arg) => arg === "-w" || arg === "--write")
        ? "managed-write"
        : "verify";
    case "eslint":
      return args.some((arg) => arg === "--fix" || arg === "--fix-dry-run")
        ? "managed-write"
        : "verify";
    case "tsc":
    case "vitest":
    case "jest":
    case "pytest":
    case "mocha":
    case "playwright":
      return args.some((arg) => /^(?:-u|--updateSnapshot|--update-snapshots)$/.test(arg))
        ? "managed-write"
        : "verify";
    case "test":
    case "[":
    case "[[":
      return "verify";
    case "make":
    case "cmake":
    case "ninja":
    case "gradle":
    case "mvn":
      return "verify";
    case "curl": {
      // 带数据/非 GET 方法会改远端状态：Plan 的只读承诺不能只覆盖本地文件
      if (isCurlMutating(args)) return "dynamic";
      return isCurlOutput(args) ? "managed-write" : "inspect";
    }
    case "wget": {
      if (isWgetMutating(args)) return "dynamic";
      return isWgetOutput(args) ? "managed-write" : "inspect";
    }
    case "python":
    case "python3":
    case "node":
    case "nodejs":
    case "ruby":
    case "php":
      // 解释器脚本可能写任意文件；具体写什么无法静态判断。
      return "dynamic";
    case "source":
    case ".":
    case "eval":
      return "dynamic";
    case "kill":
    case "pkill":
      // 进程控制是副作用，不是只读：Plan 拒绝，Agent 走审批
      return "dynamic";
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
    case "ag":
    case "ack":
    case "ls":
    case "stat":
    case "file":
    case "wc":
    case "du":
    case "df":
    case "pwd":
    case "which":
    case "type":
    case "echo":
    case "printf":
    case "true":
    case "false":
    case "sleep":
    case "date":
    case "uname":
    case "whoami":
    case "id":
    case "cd":
    case "export":
    case "unset":
    case "set":
    case "read":
    case "open":
    case "xdg-open":
      return "inspect";
    case "docker":
    case "podman":
    case "kubectl":
    case "helm":
      return "managed-write";
    case "sips": {
      // -g/--getProperty 读属性；-s/--out/-Z/-r/-c 都是命令自身写
      const reads = args.some((arg) => arg === "-g" || arg === "--getProperty");
      const writes = args.some((arg) =>
        /^(?:--out|-s|-Z|-r|--resample|-c|--crop)/.test(arg),
      );
      return reads && !writes ? "inspect" : "managed-write";
    }
    case "convert":
    case "magick":
    case "zip":
      return "managed-write";
    case "tar": {
      // 老式无短横线用法（tar tzf x.tar）也要按 t/x/c 区分
      const oldStyle = args[0] !== undefined && /^[a-zA-Z]*t[a-zA-Z]*$/.test(args[0]);
      const listOnly =
        oldStyle ||
        args.some((arg) => /^-[a-zA-Z]*t[a-zA-Z]*$/.test(arg) || arg === "--list");
      const writes =
        args.some((arg) => /^-[a-zA-Z]*[xc][a-zA-Z]*$/.test(arg)) ||
        args.some((arg) =>
          /^--(?:extract|get|create|append|update|delete)$/.test(arg),
        );
      return listOnly && !writes ? "inspect" : "managed-write";
    }
    case "unzip":
      // -l/-v/-t/-p 都是只读（列表、校验、输出到 stdout）
      return args.some(
        (arg) => arg === "-l" || arg === "-v" || arg === "-t" || arg === "-p",
      )
        ? "inspect"
        : "managed-write";
    default:
      return "dynamic";
  }
}

function classifyGit(args: string[]): ShellOperationClass {
  if (args.some((arg) => arg === "--version" || arg === "--help" || arg === "-h")) {
    return "inspect";
  }
  const { sub, rest } = firstSubcommand(args, new Set(["-C", "--git-dir", "--work-tree", "-c"]));
  if (["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "grep", "describe", "shortlog"].includes(sub)) {
    return "inspect";
  }
  if (sub === "branch") {
    // `git branch feat` 建分支、`-d/-D` 删分支；只有无位置参数或列表形态只读
    const hasList = rest.some((arg) => arg === "-l" || arg === "--list" || arg === "--show-current");
    const positional = rest.some((arg) => !arg.startsWith("-"));
    return !positional || hasList ? "inspect" : "managed-write";
  }
  if (sub === "remote") {
    const first = rest.find((arg) => !arg.startsWith("-")) ?? "";
    return ["add", "remove", "rename", "set-url", "set-head", "prune", "update"].includes(first)
      ? "managed-write"
      : "inspect";
  }
  if (sub === "stash") {
    const first = rest.find((arg) => !arg.startsWith("-")) ?? "";
    return ["list", "show", "log"].includes(first) ? "inspect" : "managed-write";
  }
  if (sub === "tag") {
    // 无位置参数（含 --sort）与 -l/--list 都是列表；带标签名才是创建/删除
    const hasList = rest.some((arg) => arg === "-l" || arg === "--list");
    const positional = rest.some((arg) => !arg.startsWith("-"));
    return hasList || !positional ? "inspect" : "managed-write";
  }
  if (sub === "submodule") {
    // 裸 `git submodule` 等价于 status
    const first = rest.find((arg) => !arg.startsWith("-")) ?? "";
    return first === "status" || first === "" ? "inspect" : "managed-write";
  }
  if (sub === "config") {
    if (rest.some((arg) => /^(?:--get|--get-all|--get-regexp|--list|-l)$/.test(arg))) {
      return "inspect";
    }
    // 一个位置参数 = 读 key；key + value 或显式写 flag 才是写
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    const writes = rest.some((arg) =>
      /^(?:--unset|--unset-all|--remove-section|--rename-section|--add|--replace-all|--edit|-e)$/.test(
        arg,
      ),
    );
    return !writes && positional.length <= 1 ? "inspect" : "managed-write";
  }
  // apply/am 是补丁式改源码，和 patch 同类；--check/--stat 只是查看。
  if (sub === "apply" || sub === "am") {
    return rest.some((arg) => /^(?:--check|--stat)$/.test(arg))
      ? "verify"
      : "inline-edit";
  }
  if (["add", "commit", "checkout", "switch", "restore", "reset", "clean", "merge", "rebase", "cherry-pick", "push", "pull", "fetch", "clone", "init", "rm", "mv"].includes(sub)) {
    return "managed-write";
  }
  return "dynamic";
}

/** package.json script 名的可静态分类集合；`pnpm run X` 与裸的 `pnpm X` 同判
 *  （pnpm/yarn/bun 会把未知裸子命令当 script 执行）。 */
const PM_VERIFY_SCRIPT =
  /^(?:test(?::.*)?|check(?::.*)?|lint(?!:fix)(?::.*)?|typecheck|type-check|build(?:.*)?|verify|ci)$/;
const PM_FORMAT_SCRIPT = /^(?:format|fix|lint:fix|fmt)$/;

function classifyPackageManager(
  name: string,
  args: string[],
  context: ShellPolicyContext,
): ShellOperationClass {
  const { sub, rest } = firstSubcommand(
    args,
    new Set([
      "--filter",
      "--prefix",
      "-C",
      "--dir",
      "--workspace",
      "--reporter",
      "--registry",
      "--cache-dir",
    ]),
  );
  if (sub === "test") {
    // vitest/jest 的快照更新会写测试文件，借 test 通道也要拦
    return rest.some((arg) =>
      /^(?:-u|-U|--update|--update-snapshots|--updateSnapshot)$/.test(arg),
    )
      ? "managed-write"
      : "verify";
  }
  // npm ci 是清空重装，必须在裸子命令正则之前截住（正则里的 ci 只该管 script 名）
  if (sub === "ci") return "managed-write";
  if (sub === "run") {
    // 跳过脚本前的 flag（pnpm run --silent build / npm run --if-present test）
    const script = rest.find((arg) => !arg.startsWith("-")) ?? "";
    if (PM_VERIFY_SCRIPT.test(script)) return "verify";
    if (PM_FORMAT_SCRIPT.test(script)) return "managed-write";
    return "dynamic";
  }
  if (sub === "exec" || sub === "dlx" || sub === "x") {
    const inner = rest.filter((arg) => arg !== "--");
    return inner.length ? classifyShellCommand(inner.join(" "), context) : "dynamic";
  }
  if (["add", "install", "i", "remove", "uninstall", "update", "up", "link", "patch", "publish", "dedupe", "prune"].includes(sub)) {
    return "managed-write";
  }
  if (PM_VERIFY_SCRIPT.test(sub)) return "verify";
  if (PM_FORMAT_SCRIPT.test(sub)) return "managed-write";
  if (sub === "") {
    return "managed-write";
  }
  return "dynamic";
}

/** 跳过前置选项（含带值选项），取第一个非选项 token 作为子命令。 */
function firstSubcommand(
  args: string[],
  valueFlags: ReadonlySet<string>,
): { sub: string; rest: string[] } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    return { sub: arg, rest: args.slice(index + 1) };
  }
  return { sub: "", rest: [] };
}

function classifyCargo(args: string[]): ShellOperationClass {
  const sub = args[0] ?? "";
  if (["test", "check", "clippy", "build", "bench", "doc", "metadata", "tree"].includes(sub)) {
    return "verify";
  }
  if (["add", "remove", "install", "uninstall", "publish", "fmt", "fix", "update", "clean"].includes(sub)) {
    return "managed-write";
  }
  return "dynamic";
}

function classifyGo(args: string[]): ShellOperationClass {
  const sub = args[0] ?? "";
  if (["test", "vet", "build", "list", "version", "env", "doc"].includes(sub)) {
    return "verify";
  }
  if (["get", "install", "fmt", "generate", "clean", "mod"].includes(sub)) {
    return "managed-write";
  }
  return "dynamic";
}

/* ------------------------------ 基础工具 ------------------------------ */

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

function isSedInPlace(arg: string): boolean {
  return arg === "--in-place" || arg.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(arg);
}

function isPerlInPlace(arg: string): boolean {
  return arg === "--in-place" || /^-[a-zA-Z]*i/.test(arg);
}

/** `-f`/`--file` 形态：脚本在磁盘上，内容对分类器不可见，无法静态判断。 */
function isFileScriptFlag(arg: string): boolean {
  return /^-[a-zA-Z]*f/.test(arg) || arg === "--file" || arg.startsWith("--file=");
}

/** gawk `-i inplace` / `-iinplace` / `--include=inplace`：只有 inplace 扩展安全 */
function isAwkInplace(args: string[]): boolean {
  return args.some((arg, index) => {
    if (arg === "-i" || arg === "--include") return args[index + 1] === "inplace";
    if (arg === "--include=inplace") return true;
    if (arg.startsWith("-i")) return arg.slice(2) === "inplace";
    return false;
  });
}

/** gawk 的 -i/--include/-l/--load：代码/共享库来自磁盘，内容不可见 */
function isAwkCodeLoading(args: string[]): boolean {
  return args.some((arg, index) => {
    if (arg === "-i" || arg === "--include") return args[index + 1] !== "inplace";
    if (arg === "--include=inplace") return false;
    if (arg.startsWith("-i")) return arg.slice(2) !== "inplace";
    if (arg === "-l" || arg === "--load") return true;
    if (arg.startsWith("--include=") || arg.startsWith("--load=")) return true;
    // 组合短选项里的 l（-lfoo 形式）
    return /^-[a-zA-Z]*l/.test(arg);
  });
}

/** curl 是否在发送数据/使用非 GET 方法（会改远端状态） */
function isCurlMutating(args: string[]): boolean {
  return args.some((arg, index) => {
    if (/^--(?:data(?:-raw|-binary|-urlencode)?|form|upload-file)(?:=|$)/.test(arg)) {
      return true;
    }
    if (/^-[dFT]/.test(arg)) return true;
    if (arg === "-X" || arg === "--request") {
      return !/^(?:GET|HEAD)$/i.test(args[index + 1] ?? "");
    }
    if (arg.startsWith("--request=")) return !/^--request=(?:GET|HEAD)$/i.test(arg);
    if (arg.startsWith("-X")) return !/^(?:GET|HEAD)$/i.test(arg.slice(2));
    return false;
  });
}

function isCurlOutput(args: string[]): boolean {
  return args.some((arg) =>
    /^(?:-o|-O|--output|--output-document)(?:=|$)/.test(arg),
  );
}

function isWgetMutating(args: string[]): boolean {
  return args.some((arg, index) => {
    if (/^--(?:post-data|post-file)(?:=|$)/.test(arg)) return true;
    if (arg === "--method") return !/^(?:GET|HEAD)$/i.test(args[index + 1] ?? "");
    if (arg.startsWith("--method=")) return !/^--method=(?:GET|HEAD)$/i.test(arg);
    return false;
  });
}

function isWgetOutput(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-O" ||
      (arg.startsWith("-O") && arg !== "-O-") ||
      arg === "--output-document" ||
      arg.startsWith("--output-document="),
  );
}

/** 逐个分类 find 的每一段 -exec/-execdir/-ok/-okdir；没有 exec 时返回 undefined。
 *  只看第一段会漏掉后面的 `-exec sed -i`（前面若是 rm/cat，整条会被当成
 *  managed-write 放行）。 */
function classifyFindExecs(
  args: string[],
  context: ShellPolicyContext,
): ShellOperationClass | undefined {
  let hasExec = false;
  let out: ShellOperationClass = "inspect";
  for (let index = 0; index < args.length; index += 1) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[index]!)) continue;
    hasExec = true;
    const command: string[] = [];
    let cursor = index + 1;
    while (
      cursor < args.length &&
      args[cursor] !== "\\;" &&
      args[cursor] !== ";" &&
      args[cursor] !== "+"
    ) {
      command.push(args[cursor]!);
      cursor += 1;
    }
    if (command.length) {
      out = worse(out, classifyCommand(command[0]!, command.slice(1), context));
      if (out === "inline-edit") return out;
    }
    index = cursor;
  }
  return hasExec ? "managed-write" : undefined;
}

function isShellWrapper(name: string): boolean {
  return ["bash", "sh", "zsh", "dash", "ksh", "fish"].includes(name);
}

function stripWrapperOptions(
  args: string[],
  extraValueFlags?: ReadonlySet<string>,
): string[] {
  let index = 0;
  // 选项与带值选项：只处理常见短选项，遇到第一个非选项即命令起点。
  const valueFlags = new Set([
    "-u",
    "-g",
    "-p",
    "-C",
    "-D",
    "-h",
    "-r",
    "-t",
    "-U",
    ...(extraValueFlags ?? []),
  ]);
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-")) {
      // env VAR=value cmd：跳过赋值，继续找真正的命令。
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        index += 1;
        continue;
      }
      break;
    }
    if (valueFlags.has(arg)) index += 2;
    else index += 1;
  }
  return args.slice(index);
}

function resolveTarget(dest: string, context: ShellPolicyContext): string | null {
  try {
    return isAbsolute(dest) ? resolve(dest) : resolve(context.cwd ?? process.cwd(), dest);
  } catch {
    return null;
  }
}

function isTempTarget(target: string, context: ShellPolicyContext): boolean {
  const roots = [...(context.tempRoots ?? []), tmpdir(), "/tmp", "/var/tmp"];
  return roots.some((root) => {
    try {
      const rel = relative(resolve(root), target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
      return false;
    }
  });
}

function isProjectTarget(target: string, context: ShellPolicyContext): boolean {
  const roots = context.roots?.length ? context.roots : context.cwd ? [context.cwd] : [];
  return roots.some((root) => {
    try {
      const rel = relative(resolve(root), target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
      return false;
    }
  });
}

/* --------------------------- 保守 fallback --------------------------- */

/** 解析器不可用时的快扫：宁严勿松，动态结构一律 dynamic。 */
function classifyFallback(command: string, context: ShellPolicyContext): ShellOperationClass {
  const text = command.trim();
  if (!text) return "dynamic";
  const dynamic = /\$\(|`|[<>]\(|\$'|\beval\b|\bsource\b|(?:^|\s)\.\s/.test(text);
  if (/\bsed\b[^|;&\n]*(?:^|\s)(?:-[a-zA-Z]*i|--in-place)\b/.test(text)) return "inline-edit";
  if (/\bperl\b[^|;&\n]*(?:^|\s)-[a-zA-Z]*i\b/.test(text)) return "inline-edit";
  if (/\b(?:tee|truncate|patch)\b/.test(text)) return "inline-edit";
  if (/(^|[^>])>{1,2}\s*(?!\/dev\/(?:null|stdout|stderr))[^\s&|]/.test(text) || /<<[^\s]*\s*>/.test(text)) {
    return "inline-edit";
  }
  if (dynamic) return "dynamic";
  if (/\bfind\b[^|;&\n]*-(?:exec|execdir|delete|ok|okdir)\b/.test(text)) return "managed-write";
  if (/\b(?:cp|mv|rm|rmdir|mkdir|touch|ln|install|rsync|chmod|chown|chgrp)\b/.test(text)) {
    return "managed-write";
  }
  if (/\b(?:prettier|eslint)\b[^|;&\n]*(?:--write|-w|--fix)\b/.test(text)) return "managed-write";
  if (/\b(?:pnpm|npm|yarn|bun|cargo|go|pip|poetry|uv)\b[^|;&\n]*(?:test|check|lint|typecheck|build)\b/.test(text)) {
    return "verify";
  }
  if (/\b(?:sed\s+-n|cat|head|tail|grep|rg|ls|echo|printf|git\s+(?:status|diff|log|show))\b/.test(text)) {
    return "inspect";
  }
  return "dynamic";
}
