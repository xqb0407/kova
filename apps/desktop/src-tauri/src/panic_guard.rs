//! 命令级 panic 隔离：让一个命令的 panic 不再带走整个应用。
//!
//! 背景（一次实机崩溃）：`eprintln!` 在写 stderr 失败时 panic，release 档
//! `panic = "abort"` 且无 catch_unwind，panic 又发生在 Tauri 命令处理器里，
//! 于是"日志写不出去"升级成"应用被 abort"。崩溃栈：
//! frontend_log → std::io::stdio::__eprint → panic_fmt → abort。
//!
//! 两道防线：
//! 1. **panic hook**（`install_panic_hook`）：任何 panic 都记进 app.log。
//!    默认 hook 只往 stderr 写，而 stderr 恰恰可能是坏的——那正是崩溃的成因；
//!    写文件才留得下证据。
//! 2. **命令异常边界**（`guard_invoke_handler`）：把 generate_handler 生成的
//!    处理器整个包进 catch_unwind。被捕获时给前端回一个 rejection，
//!    而不是让 promise 永久挂起。
//!
//! 注意：catch_unwind 生效的前提是**不能** `panic = "abort"`（abort 直接终止
//! 进程，栈不回卷，捕获无从谈起）。Cargo.toml 的 release 档因此显式去掉了它，
//! 代价是二进制带展开表、体积略增——换稳定性值得。

use std::any::Any;
use std::panic::AssertUnwindSafe;

use tauri::ipc::Invoke;
use tauri::Runtime;

/// 从 panic 载荷里取人话。`panic!("...")` 是 &str，`panic_any` 可能是别的类型。
fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "非字符串 panic 载荷".to_string()
    }
}

/// panic 位置（file:line），来自 hook 的 Location。取不到就返回 None。
fn hook_location(info: &std::panic::PanicHookInfo<'_>) -> Option<String> {
    info.location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
}

/// 安装全局 panic hook：把 panic 落 app.log，并尽力镜像到 stderr。
///
/// 幂等：重复调用只装一次。**必须在日志器初始化之后**调用，
/// 否则第一批 panic 记不进文件。
pub fn install_panic_hook() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let message = panic_message(info.payload());
            let where_ = hook_location(info).unwrap_or_else(|| "unknown location".to_string());
            // 落到 app.log：stderr 可能是坏的（这正是引入本模块的原因），文件才是可靠出口
            log::error!("[panic] {message} @ {where_}");
            // 默认 hook 再走一遍：dev 终端里保留原有的 backtrace 行为。
            // 它自己往 stderr 写——而 stderr 可能正是坏的。这里不怕：
            // std 的 default_hook 两个分支都是 `let _ = writeln!(...)`，
            // 写失败被吞掉，不会在 panic hook 里再 panic 一次（否则双重 panic 必 abort，
            // 整个加固就白做了）。见 library/std/src/panicking.rs 的 default_hook。
            previous(info);
        }));
    });
}

/// 把 Tauri 的命令处理器包进 panic 边界。
///
/// 被捕获时做两件事：记日志、给前端回 rejection。
/// 回 rejection 的关键在于**提前克隆 resolver**——`Invoke` 是按值传进内部处理器的，
/// panic 之后它已经被消费掉了，只有这份克隆还能应答。
///
/// 为什么补应答也要再包一层：`InvokeResolver::return_result` 内部是
/// `.take().expect("resolver consumed")`，同一 Invoke 应答第二次会 panic。
/// 若命令已经正常应答、之后才 panic（例如在 Drop 里），我们的补应答就会撞上那句
/// expect。那属于"前端已经拿到结果"的正常情形，静默略过即可。
pub fn guard_invoke_handler<R: Runtime, F>(inner: F) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static
where
    F: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke: Invoke<R>| {
        // 命令名先取出来：panic 之后再想拿就得有个存活到那时的副本
        let cmd = invoke.message.command().to_string();
        let backup = invoke.resolver.clone();
        match std::panic::catch_unwind(AssertUnwindSafe(|| inner(invoke))) {
            Ok(handled) => handled,
            Err(payload) => {
                let message = panic_message(payload.as_ref());
                log::error!("[panic] command `{cmd}` panicked: {message}");
                let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    backup.reject(format!(
                        "内部错误：命令 `{cmd}` 发生异常（{message}）。该操作已中止，应用其余部分不受影响。"
                    ));
                }));
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_message_reads_str_and_string_payloads() {
        let a: Box<dyn Any + Send> = Box::new("boom");
        let b: Box<dyn Any + Send> = Box::new(String::from("kaboom"));
        let c: Box<dyn Any + Send> = Box::new(42u32);
        assert_eq!(panic_message(a.as_ref()), "boom");
        assert_eq!(panic_message(b.as_ref()), "kaboom");
        assert_eq!(panic_message(c.as_ref()), "非字符串 panic 载荷");
    }

    /// 这是加固的核心契约：一个 panic 的闭包被 catch_unwind 拦住，调用方拿到 Err 而不是进程死。
    /// 只有在 Cargo.toml 未设 `panic = "abort"` 时这条才成立——那条约束由本模块文档说明，
    /// 测试本身跑在 dev 档（默认 unwind）下验证逻辑正确性。
    #[test]
    fn catch_unwind_contains_a_panicking_closure() {
        let caught = std::panic::catch_unwind(AssertUnwindSafe(|| {
            panic!("命令里的意外 panic");
        }));
        assert!(caught.is_err());
        // 能走到这里，就说明 panic 没有带走进程
        assert_eq!(panic_message(caught.unwrap_err().as_ref()), "命令里的意外 panic");
    }

    /// 反证：`panic = "abort"` 语义下捕获不成立。
    /// 无法在进程内直接演示 abort（那会杀掉测试进程），
    /// 因此这里改为断言 Cargo.toml 不再启用该档——配置漂移会让加固静默失效。
    #[test]
    fn release_profile_does_not_abort_on_panic() {
        let manifest = include_str!("../Cargo.toml");
        let release = manifest
            .split("[profile.release]")
            .nth(1)
            .expect("Cargo.toml 应有 [profile.release] 段");
        // 只认真正的 TOML 键：注释里出现 panic = "abort"（本模块的说明文字）
        // 不该被判成配置漂移。所以先剥掉注释与空行。
        let abort_line = release
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .find(|l| l.starts_with("panic") && l.contains("abort"));
        assert!(
            abort_line.is_none(),
            "release 档启用 panic 中止会让 catch_unwind 失效，panic 隔离随之失效：{abort_line:?}"
        );
    }
}
