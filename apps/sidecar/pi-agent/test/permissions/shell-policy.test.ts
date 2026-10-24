import { beforeAll, describe, expect, test } from "bun:test";
import {
  classifyShellCommand,
  initShellPolicy,
  resetShellPolicyForTest,
  type ShellOperationClass,
  type ShellPolicyContext,
} from "../../src/permissions/shell-policy";

const PROJ = "/tmp/kova-shell-policy-project";
const CTX: ShellPolicyContext = {
  cwd: PROJ,
  roots: [PROJ],
  tempRoots: ["/tmp/kova-shell-policy-temp"],
};

beforeAll(async () => {
  await initShellPolicy();
});

const classify = (command: string): ShellOperationClass =>
  classifyShellCommand(command, CTX);

describe("shell-policy: 查看/验证", () => {
  test("只读文本工具", () => {
    expect(classify("sed -n '1,5p' a.txt")).toBe("inspect");
    expect(classify("cat a.txt")).toBe("inspect");
    expect(classify("grep -n foo a.txt")).toBe("inspect");
    expect(classify("ls -la")).toBe("inspect");
    expect(classify("git status")).toBe("inspect");
    expect(classify("git diff --stat")).toBe("inspect");
    expect(classify("echo ok >/dev/null")).toBe("inspect");
  });

  test("测试/构建/类型检查", () => {
    expect(classify("pnpm test")).toBe("verify");
    expect(classify("bun test")).toBe("verify");
    expect(classify("npm run build")).toBe("verify");
    expect(classify("tsc --noEmit")).toBe("verify");
    expect(classify("eslint .")).toBe("verify");
    expect(classify("prettier --check a.ts")).toBe("verify");
    expect(classify("pnpm --filter app test")).toBe("verify");
    expect(classify("pnpm run test:unit")).toBe("verify");
    expect(classify("git -C repo status")).toBe("inspect");
  });

  test("git/tar/unzip 只读形态", () => {
    expect(classify("git stash list")).toBe("inspect");
    expect(classify("git stash show")).toBe("inspect");
    expect(classify("git tag -l")).toBe("inspect");
    expect(classify("git submodule status")).toBe("inspect");
    expect(classify("git submodule")).toBe("inspect");
    expect(classify("git branch")).toBe("inspect");
    expect(classify("git branch --show-current")).toBe("inspect");
    expect(classify("git remote -v")).toBe("inspect");
    expect(classify("tar -tzf x.tgz")).toBe("inspect");
    expect(classify("tar --list -f x.tar")).toBe("inspect");
    expect(classify("unzip -l x.zip")).toBe("inspect");
  });

  test("包管理器裸子命令与 run 同判", () => {
    expect(classify("pnpm build")).toBe("verify");
    expect(classify("pnpm typecheck")).toBe("verify");
    expect(classify("yarn lint")).toBe("verify");
    expect(classify("pnpm --filter app build")).toBe("verify");
    expect(classify("pnpm format")).toBe("managed-write");
    // 脚本前的 flag 不能把 script 名挤掉
    expect(classify("pnpm run --silent build")).toBe("verify");
    expect(classify("npm run --if-present test")).toBe("verify");
    expect(classify("pnpm run -- build")).toBe("verify");
  });

  test("更多只读形态", () => {
    expect(classify("git tag")).toBe("inspect");
    expect(classify("git tag --sort=-creatordate")).toBe("inspect");
    expect(classify("git config user.name")).toBe("inspect");
    expect(classify("tar tzf x.tar")).toBe("inspect");
    expect(classify("unzip -p x.zip f")).toBe("inspect");
    expect(classify("sips -g all x.png")).toBe("inspect");
    expect(classify("curl https://x")).toBe("inspect");
    expect(classify("curl -I https://x")).toBe("inspect");
  });
});

describe("shell-policy: 命令自身写", () => {
  test("formatter / 包管理器 / git 写 / 文件操作", () => {
    expect(classify("prettier --write a.ts")).toBe("managed-write");
    expect(classify("eslint --fix .")).toBe("managed-write");
    expect(classify("pnpm add react")).toBe("managed-write");
    expect(classify("pnpm run lint:fix")).toBe("managed-write");
    expect(classify("git commit -m x")).toBe("managed-write");
    expect(classify("git apply fix.patch")).toBe("inline-edit");
    expect(classify("git apply --check fix.patch")).toBe("verify");
    expect(classify("cp a.txt b.txt")).toBe("managed-write");
    expect(classify("rm a.txt")).toBe("managed-write");
    expect(classify("find . -exec rm {} \\;")).toBe("managed-write");
    expect(classify("find . -exec sed -i s/a/b/ {} \\;")).toBe("inline-edit");
    expect(classify("xargs sed -i s/a/b/")).toBe("inline-edit");
    expect(classify("git branch feat")).toBe("managed-write");
    expect(classify("git branch -d feat")).toBe("managed-write");
    expect(classify("git remote add origin url")).toBe("managed-write");
    expect(classify("git remote prune origin")).toBe("managed-write");
    expect(classify("git stash push -m x")).toBe("managed-write");
    expect(classify("git tag v1.0.0")).toBe("managed-write");
    expect(classify("git submodule add url p")).toBe("managed-write");
    expect(classify("git rm a.txt")).toBe("managed-write");
    expect(classify("git mv a b")).toBe("managed-write");
    expect(classify("npm ci")).toBe("managed-write");
    expect(classify("pnpm test -u")).toBe("managed-write");
    expect(classify("tar -xzf x.tgz")).toBe("managed-write");
    expect(classify("unzip x.zip -d out")).toBe("managed-write");
    expect(classify("git config user.name x")).toBe("managed-write");
    expect(classify("git config --unset user.name")).toBe("managed-write");
    expect(classify("curl -o out.json https://x")).toBe("managed-write");
    expect(classify("wget -O out.html https://x")).toBe("managed-write");
  });
});

describe("shell-policy: 手工改文件", () => {
  test("in-place 编辑器与重定向", () => {
    expect(classify("sed -i 's/a/b/' a.txt")).toBe("inline-edit");
    expect(classify("perl -pi -e 's/a/b/' a.txt")).toBe("inline-edit");
    expect(classify("echo hi > a.txt")).toBe("inline-edit");
    expect(classify("cat <<EOF > a.txt\nhello\nEOF")).toBe("inline-edit");
    expect(classify("tee a.txt")).toBe("inline-edit");
    expect(classify("echo hi >> a.txt")).toBe("inline-edit");
    expect(classify("awk -iinplace 'BEGIN{print 1}' a.txt")).toBe("inline-edit");
    expect(classify("sed -n '1w out.txt' a.txt")).toBe("inline-edit");
    expect(classify("sed -n 'e touch x' a.txt")).toBe("inline-edit");
    expect(classify("awk 'BEGIN{system(\"touch x\")}' a.txt")).toBe("inline-edit");
    expect(classify("perl -e 'open my $f, \">\", \"x\"'")).toBe("inline-edit");
  });

  test("引号/赋值里的命令替换也要识别", () => {
    expect(classify('echo "$(sed -i s/a/b/ a.txt)"')).toBe("inline-edit");
    expect(classify("x=$(sed -i s/a/b/ a.txt)")).toBe("inline-edit");
    expect(classify("x=$(rm -f a.txt)")).toBe("dynamic");
  });

  test("只读诊断命令不误报", () => {
    expect(classify("command -v git")).toBe("inspect");
    expect(classify("git --version")).toBe("inspect");
  });

  test("wrapper / 替换仍能识别", () => {
    expect(classify("bash -c 'sed -i s/a/b/ a.txt'")).toBe("inline-edit");
    expect(classify("bash -lc 'sed -i s/a/b/ a.txt'")).toBe("inline-edit");
    expect(classify("env FOO=1 sed -i s/a/b/ a.txt")).toBe("inline-edit");
    expect(classify("sudo -u bob sed -i s/a/b/ a.txt")).toBe("inline-edit");
    expect(classify("npx --yes prettier --write a.ts")).toBe("managed-write");
  });

  test("项目外/临时目录重定向不算项目手写", () => {
    expect(classify("echo ok > /tmp/kova-shell-policy-temp/log")).toBe("inspect");
    expect(classify("echo ok > /tmp/kova-shell-policy-temp/log")).not.toBe("inline-edit");
  });
});

describe("shell-policy: 动态结构", () => {
  test("解释器脚本文件内容不可见，一律 dynamic", () => {
    expect(classify("perl evil.pl")).toBe("dynamic");
    expect(classify("perl -n")).toBe("dynamic");
    expect(classify("perl -e 'print 1'")).toBe("dynamic");
    expect(classify("perl --version")).toBe("inspect");
    expect(classify("perl -v")).toBe("inspect");
    expect(classify("awk -f w.awk f")).toBe("dynamic");
    expect(classify("gawk --file=w.awk f")).toBe("dynamic");
    expect(classify("sed -f s.sed a.txt")).toBe("dynamic");
    // gawk 的 -i/--include/-l/--load 同样加载磁盘代码；只有 inplace 例外
    expect(classify("awk -i evil.awk '{print}' f")).toBe("dynamic");
    expect(classify("gawk --include=evil.awk '{print}' f")).toBe("dynamic");
    expect(classify("gawk --load=evil.so '{print}' f")).toBe("dynamic");
    expect(classify("gawk -l evil.so '{print}' f")).toBe("dynamic");
  });

  test("多段 find -exec 逐段分类", () => {
    expect(
      classify("find . -exec rm {} \\; -exec sed -i s/a/b/ {} \\;"),
    ).toBe("inline-edit");
    expect(classify("find . -exec cat {} \\; -exec tee out.txt \\;")).toBe(
      "inline-edit",
    );
    expect(classify("find . -exec rm {} \\; -exec cat {} \\;")).toBe("managed-write");
  });

  test("kill 与变异 curl/wget 不是只读", () => {
    expect(classify("kill 123")).toBe("dynamic");
    expect(classify("pkill -f node")).toBe("dynamic");
    expect(classify("curl -X POST -d @d.json https://x")).toBe("dynamic");
    expect(classify("curl -XPOST https://x")).toBe("dynamic");
    expect(classify("wget --post-data=a=b https://x")).toBe("dynamic");
  });

  test("awk 管道执行命令不是只读", () => {
    expect(classify("awk '{\"touch x\" | getline}' f")).toBe("dynamic");
    expect(classify("awk '{print | \"touch x\"}' f")).toBe("dynamic");
    expect(classify("awk '{\"cmd\" |& getline}' f")).toBe("dynamic");
  });

  test("awk 正则 alternation 与普通 awk 不回归", () => {
    expect(classify("awk '/a|b/{print}' f")).toBe("inspect");
    expect(classify("awk '{print \"a|b\"}' f")).toBe("inspect");
    expect(classify("awk '{print}' f")).toBe("inspect");
  });

  test("命令替换/子 shell/解释器", () => {
    expect(classify("echo $(touch x)")).toBe("dynamic");
    expect(classify("echo `touch x`")).toBe("dynamic");
    expect(classify("python -c 'open(\"x\",\"w\")'")).toBe("dynamic");
    expect(classify("node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'")).toBe("dynamic");
    expect(classify("(cd sub && sed -i s/a/b/ f)")).toBe("inline-edit");
  });

  test("空命令", () => {
    expect(classify("   ")).toBe("dynamic");
  });
});

describe("shell-policy: fallback", () => {
  test("解析器不可用时仍能识别高信号写入", () => {
    resetShellPolicyForTest();
    expect(classify("sed -i s/a/b/ f")).toBe("inline-edit");
    expect(classify("sed -n '1,5p' f")).toBe("inspect");
    expect(classify("echo x > f")).toBe("inline-edit");
    expect(classify("pnpm test")).toBe("verify");
  });

  test("fallback 与 AST 对齐 /dev/* 目标", () => {
    resetShellPolicyForTest();
    expect(classify("pnpm test 2>/dev/null")).toBe("verify");
    expect(classify("echo ok >/dev/null")).toBe("inspect");
  });
});
