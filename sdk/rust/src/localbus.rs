//! 本机消息总线：命名管道（Windows）+ Unix Domain Socket（Linux/macOS）双实现。
//!
//! 作用：在「配置程序窗口」和「synapse-agent 客户端」之间建立一条可靠的双向文本通道。
//!   - agent 读取新消息：配置程序往管道写，agent 从管道读 → 交给上层处理/上报 Hub。
//!   - agent 发新消息给配置程序：agent 往管道写，配置程序读取显示。
//!
//! 协议：UTF-8 JSON Lines（每行一条消息，`\n` 结尾），字段对齐 Hub Envelope 约定但更精简：
//!   {"id":"...","dir":"in|out","sender":"...","topic":"...","text":"...","ts":...,"meta":{}}
//!   dir=in  表示从配置程序进入 agent；dir=out 表示 agent 发给配置程序。
//!
//! 非 Windows 平台回退到 Unix Domain Socket（路径 `<状态目录>/agent_<agent-id>.sock`，
//! 状态目录缺省 `~/.synapse-agent`，可用 --config-dir / SYNAPSE_AGENT_DIR 覆盖），
//! 让协议与逻辑可以在 Linux/macOS 上开发与测试；Windows 用命名管道
//! `\\.\pipe\synapse_agent_<sanitized-agent-id>`。

use serde_json::{json, Value};
#[cfg(windows)]
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(not(windows))]
use std::io::{BufRead, BufReader, Write};

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

/// 生成一条协议消息；调用方只需给 text/sender/topic。
pub fn make_msg(dir: &str, sender: &str, topic: &str, text: &str, meta: Value) -> Value {
    json!({
        "id": format!("m-{}", now_ms()),
        "dir": dir,
        "sender": sender,
        "topic": topic,
        "text": text,
        "ts": now_ms(),
        "meta": meta,
    })
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// 管道/套接口名字。Windows 用命名管道（按 agent id 区分，与状态目录无关）；
/// 非 Windows 的套接字放在状态目录下（缺省 ~/.synapse-agent，可用 --config-dir /
/// SYNAPSE_AGENT_DIR 覆盖），文件名按 agent id 区分，同机多身份互不冲突。
#[cfg(windows)]
pub fn endpoint_name(_dir: &std::path::Path, agent_id: &str) -> String {
    format!(r"\\.\pipe\synapse_agent_{}", sanitize(agent_id))
}

#[cfg(not(windows))]
pub fn endpoint_name(dir: &std::path::Path, agent_id: &str) -> String {
    let p = dir.join(format!("agent_{}.sock", sanitize(agent_id)));
    p.to_string_lossy().to_string()
}

/// 校验一条入站协议消息。
pub fn parse_msg(line: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("JSON 解析失败: {e}"))?;
    if !v.is_object() {
        return Err("消息必须是 JSON 对象".into());
    }
    if v.get("text").and_then(|x| x.as_str()).is_none() {
        return Err("消息缺少 text 字段".into());
    }
    Ok(v)
}

// ────────────────────────── 服务端：监听并逐条回调 ──────────────────────────

/// 监听端点，对每条收到的消息调用 `on_msg(text)`；返回消息里携带的回复文本写回对端。
/// 这是给「agent 读取新消息」用的：配置程序写入 → 回调里处理 → 可选回执。
#[cfg(windows)]
pub fn serve<F>(name: &str, on_msg: F) -> Result<(), String>
where
    F: Fn(Value) -> Option<String> + Send + Sync + 'static,
{
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsString;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(
            lp_name: *const u16, dw_open_mode: u32, dw_pipe_mode: u32,
            n_max_instances: u32, n_out_buffer_size: u32, n_in_buffer_size: u32,
            n_default_timeout: u32, lp_security_attributes: *mut std::ffi::c_void,
        ) -> isize;
        fn ConnectNamedPipe(h_pipe: isize, lp_overlapped: *mut std::ffi::c_void) -> i32;
        fn DisconnectNamedPipe(h_pipe: isize) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn ReadFile(
            h: isize, buf: *mut u8, n: u32, read: *mut u32, ov: *mut std::ffi::c_void,
        ) -> i32;
        fn WriteFile(
            h: isize, buf: *const u8, n: u32, wrote: *mut u32, ov: *mut std::ffi::c_void,
        ) -> i32;
    }

    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    const PIPE_TYPE_MESSAGE: u32 = 0x0000_0004;
    const PIPE_READMODE_MESSAGE: u32 = 0x0000_0002;
    const PIPE_WAIT: u32 = 0x0000_0000;
    const PIPE_UNLIMITED_INSTANCES: u32 = 255;

    let wide: Vec<u16> = OsString::from(name)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let server = CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            std::ptr::null_mut(),
        );
        if server == -1 {
            return Err(format!("CreateNamedPipeW 失败: {}", io::Error::last_os_error()));
        }
        eprintln!("[localbus] 监听 {name}");
        loop {
            let ok = ConnectNamedPipe(server, std::ptr::null_mut());
            // ERROR_PIPE_CONNECTED=232 表示连接已建立
            if ok == 0 && io::Error::last_os_error().raw_os_error() != Some(232) {
                let e = io::Error::last_os_error();
                CloseHandle(server);
                return Err(format!("ConnectNamedPipe 失败: {e}"));
            }
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let mut read = 0u32;
                let r = ReadFile(
                    server, buf.as_mut_ptr(), buf.len() as u32, &mut read, std::ptr::null_mut(),
                );
                if r == 0 || read == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buf[..read as usize]).to_string();
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match parse_msg(line) {
                        Ok(v) => {
                            if let Some(reply) = on_msg(v) {
                                let mut rb = reply.into_bytes();
                                rb.push(b'\n');
                                let mut wrote = 0u32;
                                WriteFile(
                                    server, rb.as_ptr(), rb.len() as u32, &mut wrote,
                                    std::ptr::null_mut(),
                                );
                            }
                        }
                        Err(e) => eprintln!("[localbus] 丢弃坏消息: {e}"),
                    }
                }
            }
            DisconnectNamedPipe(server);
        }
        #[allow(unreachable_code)]
        {
            CloseHandle(server);
            Ok(())
        }
    }
}

#[cfg(not(windows))]
pub fn serve<F>(name: &str, on_msg: F) -> Result<(), String>
where
    F: Fn(Value) -> Option<String> + Send + Sync + 'static,
{
    use std::os::unix::net::UnixListener;
    let _ = std::fs::remove_file(name);
    let listener = UnixListener::bind(name).map_err(|e| format!("bind {name} 失败: {e}"))?;
    eprintln!("[localbus] 监听 {name}");
    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Ok(reader_stream) = stream.try_clone() {
            let mut reader = BufReader::new(reader_stream);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match parse_msg(line) {
                    Ok(v) => {
                        if let Some(reply) = on_msg(v) {
                            let _ = stream.write_all(reply.as_bytes());
                            let _ = stream.write_all(b"\n");
                            let _ = stream.flush();
                        }
                    }
                    Err(e) => eprintln!("[localbus] 丢弃坏消息: {e}"),
                }
            }
        }
    }
    Ok(())
}

// ────────────────────────── 客户端：连接并发送一条消息 ──────────────────────────

/// 发送一条消息到端点，并等待（可选）回执；超时由连接方整体控制。
#[cfg(windows)]
pub fn send_one(name: &str, msg: &Value, wait_reply: bool) -> Result<Option<String>, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn WaitNamedPipeW(lp_named_pipe_name: *const u16, n_timeout: u32) -> i32;
        fn CreateFileW(
            lp_file_name: *const u16, dw_desired_access: u32, dw_share_mode: u32,
            lp_security_attributes: *mut std::ffi::c_void, dw_creation_disposition: u32,
            dw_flags_and_attributes: u32, h_template_file: isize,
        ) -> isize;
        fn WriteFile(
            h: isize, buf: *const u8, n: u32, wrote: *mut u32, ov: *mut std::ffi::c_void,
        ) -> i32;
        fn ReadFile(
            h: isize, buf: *mut u8, n: u32, read: *mut u32, ov: *mut std::ffi::c_void,
        ) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }
    const GENERIC_READ_WRITE: u32 = 0x8000_0000 | 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    let wide: Vec<u16> = OsString::from(name)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        WaitNamedPipeW(wide.as_ptr(), 3000);
        let h = CreateFileW(
            wide.as_ptr(), GENERIC_READ_WRITE, 0, std::ptr::null_mut(),
            OPEN_EXISTING, 0, 0,
        );
        if h == -1 {
            return Err(format!("连接管道失败: {}", io::Error::last_os_error()));
        }
        let mut payload = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        payload.push(b'\n');
        let mut wrote = 0u32;
        let wr = WriteFile(
            h, payload.as_ptr(), payload.len() as u32, &mut wrote, std::ptr::null_mut(),
        );
        if wr == 0 {
            CloseHandle(h);
            return Err(format!("写管道失败: {}", io::Error::last_os_error()));
        }
        let mut reply = None;
        if wait_reply {
            let mut buf = vec![0u8; 64 * 1024];
            let mut read = 0u32;
            if ReadFile(h, buf.as_mut_ptr(), buf.len() as u32, &mut read, std::ptr::null_mut()) != 0
                && read > 0
            {
                reply = Some(String::from_utf8_lossy(&buf[..read as usize]).trim().to_string());
            }
        }
        CloseHandle(h);
        Ok(reply)
    }
}

#[cfg(not(windows))]
pub fn send_one(name: &str, msg: &Value, wait_reply: bool) -> Result<Option<String>, String> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(name).map_err(|e| format!("连接 {name} 失败: {e}"))?;
    let mut payload = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    payload.push(b'\n');
    stream.write_all(&payload).map_err(|e| e.to_string())?;
    stream.flush().ok();
    if wait_reply {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        Ok(Some(line.trim().to_string()))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn endpoint_name_lives_under_the_given_state_dir() {
        // 套接字必须落在解析后的状态目录下：两个不同目录（或不同 agent id）互不冲突。
        let d1 = std::path::PathBuf::from("/tmp/inst-a");
        let d2 = std::path::PathBuf::from("/tmp/inst-b");
        assert_eq!(
            endpoint_name(&d1, "agent-1"),
            "/tmp/inst-a/agent_agent-1.sock"
        );
        assert_ne!(endpoint_name(&d1, "agent-1"), endpoint_name(&d2, "agent-1"));
        assert_ne!(endpoint_name(&d1, "agent-1"), endpoint_name(&d1, "agent-2"));
    }

    #[cfg(windows)]
    #[test]
    fn endpoint_name_windows_pipe_ignores_state_dir() {
        let d = std::path::PathBuf::from(r"C:\whatever");
        assert_eq!(
            endpoint_name(&d, "agent-1"),
            r"\\.\pipe\synapse_agent_agent-1"
        );
    }
}
