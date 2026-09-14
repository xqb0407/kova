//! 通用 HTTP POST 出口：webhook 推送等外部集成的统一发送通道。
//! webview 里的 fetch 受 CORS 限制（钉钉/飞书等不回 CORS 头），统一走这里。
//! 业务语义（组包/签名）留在前端，本命令只负责"带着这些头发出去"，
//! 以后升级检查、遥测等出站需求同样复用。

use std::time::Duration;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpPostResult {
    pub status: u16,
    pub ok: bool,
    /// 响应体前 500 字符，供调用方展示与排错
    pub snippet: String,
}

#[tauri::command]
pub async fn http_post(
    url: String,
    body: String,
    headers: Vec<(String, String)>,
    timeout_ms: Option<u64>,
) -> Result<HttpPostResult, String> {
    // 只放行 http/https，挡掉 file:// 等意外目标
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme: {}", parsed.scheme()));
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000));
    // blocking client 挪进 spawn_blocking，不占 async runtime 线程
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = client.post(parsed).body(body);
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = req.send().map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        Ok(HttpPostResult {
            status,
            ok: (200..300).contains(&status),
            snippet: text.chars().take(500).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
