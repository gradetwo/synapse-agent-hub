//! Windows 窗口桥：发现/激活第三方窗口（如豆包）、注入文字、读取窗口文本。
//!
//! 设计要点（来自实测经验）：
//!   - 中文一律走「剪贴板 + Ctrl+V」，不用逐字符 SendInput；否则输入法状态会打乱字符。
//!   - SetForegroundWindow 有前台限制，用 AttachThreadInput 附加到前台线程绕过。
//!   - Electron / 自绘窗口的定位优先用窗口标题子串匹配（标题随版本变，不做精确匹配）。
//!   - 读取窗口文本用 Ctrl+A / Ctrl+C 抓剪贴板，尽力而为；非 Windows 平台编译为桩并返回错误。
//!
//! 该模块只依赖系统 DLL（user32 / kernel32），不引入任何第三方 crate。

use serde_json::{json, Value};

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::os::raw::c_uint;
#[cfg(windows)]
use std::os::raw::{c_int, c_long};

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::os::raw::{c_int, c_long, c_uint};

    pub type HWND = *mut c_void;
    pub type HANDLE = *mut c_void;
    pub type DWORD = u32;
    pub type BOOL = c_int;
    pub type WPARAM = usize;
    pub type LPARAM = isize;
    pub type LRESULT = isize;

    pub const WM_COPYDATA: c_uint = 0x004A;
    pub const SMTO_ABORTIFHUNG: c_uint = 0x0002;
    pub const CF_UNICODETEXT: c_uint = 13;
    pub const GMEM_MOVEABLE: c_uint = 0x0002;
    pub const SW_RESTORE: c_int = 9;
    pub const VK_CONTROL: u8 = 0x11;
    pub const VK_A: u8 = 0x41;
    pub const VK_C: u8 = 0x43;
    pub const VK_V: u8 = 0x56;
    pub const VK_RETURN: u8 = 0x0D;
    pub const KEYEVENTF_KEYUP: DWORD = 0x0002;
    pub const VK_MENU: u8 = 0x12;
    pub const MAPVK_VK_TO_VSC: c_uint = 0;
    pub const TH32CS_SNAPPROCESS: DWORD = 0x00000002;

    #[repr(C)]
    pub struct PROCESSENTRY32W {
        pub dw_size: DWORD,
        pub cnt_usage: DWORD,
        pub th32_process_id: DWORD,
        pub th32_default_heap_id: usize,
        pub th32_module_id: DWORD,
        pub cnt_threads: DWORD,
        pub th32_parent_process_id: DWORD,
        pub pc_pri_class_base: c_int,
        pub dw_flags: DWORD,
        pub sz_exe_file: [u16; 260],
    }

    #[repr(C)]
    pub struct COPYDATASTRUCT {
        pub dw_data: usize,
        pub cb_data: DWORD,
        pub lp_data: *mut c_void,
    }

    pub type WndEnumProc = Option<extern "system" fn(HWND, LPARAM) -> BOOL>;

    #[link(name = "user32")]
    extern "system" {
        pub fn FindWindowW(lp_class_name: *const u16, lp_window_name: *const u16) -> HWND;
        pub fn EnumWindows(lp_enum_proc: WndEnumProc, l_param: LPARAM) -> BOOL;
        pub fn GetWindowTextLengthW(h_wnd: HWND) -> c_int;
        pub fn GetWindowTextW(h_wnd: HWND, lp_string: *mut u16, n_max_count: c_int) -> c_int;
        pub fn IsWindowVisible(h_wnd: HWND) -> BOOL;
        pub fn GetForegroundWindow() -> HWND;
        pub fn SetForegroundWindow(h_wnd: HWND) -> BOOL;
        pub fn BringWindowToTop(h_wnd: HWND) -> BOOL;
        pub fn SetFocus(h_wnd: HWND) -> HWND;
        pub fn ShowWindow(h_wnd: HWND, n_cmd_show: c_int) -> BOOL;
        pub fn GetWindowThreadProcessId(h_wnd: HWND, lpdw_process_id: *mut DWORD) -> DWORD;
        pub fn AttachThreadInput(id_attach: DWORD, id_attach_to: DWORD, f_attach: BOOL) -> BOOL;
        pub fn GetCurrentThreadId() -> DWORD;
        pub fn SendMessageTimeoutW(
            h_wnd: HWND, msg: c_uint, w_param: WPARAM, l_param: LPARAM,
            fu_flags: c_uint, u_timeout: c_uint, lpdw_result: *mut usize,
        ) -> LRESULT;
        pub fn keybd_event(b_vk: u8, b_scan: u8, dw_flags: DWORD, dw_extra_info: usize);
        pub fn OpenClipboard(h_wnd_new_owner: HWND) -> BOOL;
        pub fn CloseClipboard() -> BOOL;
        pub fn EmptyClipboard() -> BOOL;
        pub fn SetClipboardData(u_format: c_uint, h_mem: HANDLE) -> HANDLE;
        pub fn GetClipboardData(u_format: c_uint) -> HANDLE;
        pub fn GetClipboardSequenceNumber() -> DWORD;
        pub fn MapVirtualKeyW(u_code: c_uint, u_map_type: c_uint) -> c_uint;
        pub fn SwitchToThisWindow(h_wnd: HWND, f_alt_tab: BOOL);
        pub fn AllowSetForegroundWindow(dw_process_id: DWORD) -> BOOL;
        pub fn SetCursorPos(x: c_int, y: c_int) -> BOOL;
        pub fn mouse_event(dw_flags: DWORD, dx: DWORD, dy: DWORD, dw_data: usize, dw_extra: usize);
        pub fn GetWindowRect(h_wnd: HWND, lp_rect: *mut RECT);
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct RECT {
        pub left: c_long,
        pub top: c_long,
        pub right: c_long,
        pub bottom: c_long,
    }

    pub const MOUSEEVENTF_LEFTDOWN: DWORD = 0x0002;
    pub const MOUSEEVENTF_LEFTUP: DWORD = 0x0004;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GlobalAlloc(u_flags: c_uint, dw_bytes: usize) -> HANDLE;
        pub fn GlobalLock(h_mem: HANDLE) -> *mut c_void;
        pub fn GlobalUnlock(h_mem: HANDLE) -> BOOL;
        pub fn GetLastError() -> DWORD;
        pub fn Sleep(dw_milliseconds: DWORD);
        pub fn CreateToolhelp32Snapshot(dw_flags: DWORD, th32_process_id: DWORD) -> HANDLE;
        pub fn Process32FirstW(h_snapshot: HANDLE, lp_pe: *mut PROCESSENTRY32W) -> BOOL;
        pub fn Process32NextW(h_snapshot: HANDLE, lp_pe: *mut PROCESSENTRY32W) -> BOOL;
        pub fn CloseHandle(h_object: HANDLE) -> BOOL;
    }
}

/// 顶层窗口信息。
#[derive(Debug, Clone)]
pub struct WindowInfo {
    pub hwnd: usize,
    pub title: String,
    pub visible: bool,
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 枚举顶层窗口，按标题子串过滤（大小写不敏感）。空子串返回全部可见窗口。
#[cfg(windows)]
pub fn list_windows(filter: &str) -> Result<Vec<WindowInfo>, String> {
    struct Ctx {
        needle: String,
        out: Vec<WindowInfo>,
    }
    extern "system" fn cb(hwnd: sys::HWND, lparam: sys::LPARAM) -> sys::BOOL {
        unsafe {
            let ctx = &mut *(lparam as *mut Ctx);
            let len = sys::GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return 1;
            }
            let mut buf = vec![0u16; (len as usize) + 1];
            let n = sys::GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if n <= 0 {
                return 1;
            }
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            let visible = sys::IsWindowVisible(hwnd) != 0;
            let hit = ctx.needle.is_empty()
                || title.to_lowercase().contains(&ctx.needle.to_lowercase());
            if hit && visible {
                ctx.out.push(WindowInfo {
                    hwnd: hwnd as usize,
                    title,
                    visible,
                });
            }
        }
        1 // 继续枚举
    }
    let mut ctx = Ctx { needle: filter.to_string(), out: Vec::new() };
    let ok = unsafe { sys::EnumWindows(Some(cb), &mut ctx as *mut Ctx as sys::LPARAM) };
    if ok == 0 {
        return Err("EnumWindows 调用失败".into());
    }
    Ok(ctx.out)
}

#[cfg(not(windows))]
pub fn list_windows(_filter: &str) -> Result<Vec<WindowInfo>, String> {
    Err("窗口桥仅在 Windows 上可用（当前为非 Windows 平台）".into())
}

/// 按标题子串找第一个窗口；找不到返回 Err。
pub fn find_window(title_contains: &str) -> Result<WindowInfo, String> {
    let list = list_windows(title_contains)?;
    list.into_iter()
        .next()
        .ok_or_else(|| format!("未找到标题包含「{title_contains}」的窗口"))
}

/// 按应用/进程名发现窗口：先找匹配的进程 PID 集合，再枚举属于这些 PID 的可见窗口。
/// 例如 "豆包" / "Doubao" / "doubao.exe" 都能命中。无需用户手输窗口标题。
#[cfg(windows)]
pub fn find_app_window(app: &str) -> Result<WindowInfo, String> {
    let needle = app.trim().trim_end_matches(".exe").to_lowercase();
    if needle.is_empty() {
        return Err("应用名不能为空".into());
    }
    // 1) 收集匹配进程的 PID
    let mut pids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    unsafe {
        let snap = sys::CreateToolhelp32Snapshot(sys::TH32CS_SNAPPROCESS, 0);
        if snap as isize == -1 {
            return Err("CreateToolhelp32Snapshot 失败".into());
        }
        let mut pe: sys::PROCESSENTRY32W = std::mem::zeroed();
        pe.dw_size = std::mem::size_of::<sys::PROCESSENTRY32W>() as u32;
        let mut ok = sys::Process32FirstW(snap, &mut pe);
        while ok != 0 {
            let name_len = pe.sz_exe_file.iter().position(|&c| c == 0).unwrap_or(260);
            let proc_name = String::from_utf16_lossy(&pe.sz_exe_file[..name_len]).to_lowercase();
            let proc_base = proc_name.trim_end_matches(".exe");
            // 中英文别名：豆包<->doubao，允许子串双向匹配
            let alias_hit = proc_base.contains(&needle)
                || needle.contains(proc_base)
                || (needle.contains("豆包") && proc_base.contains("doubao"))
                || (needle.contains("doubao") && proc_base.contains("豆包"));
            if alias_hit {
                pids.insert(pe.th32_process_id);
            }
            ok = sys::Process32NextW(snap, &mut pe);
        }
        sys::CloseHandle(snap);
    }
    if pids.is_empty() {
        return Err(format!("未找到名为「{app}」的进程，请确认应用已启动"));
    }

    // 2) 枚举顶层窗口，取属于这些 PID 的可见窗口（优先标题非空的）
    struct Ctx { pids: std::collections::HashSet<u32>, found: Vec<WindowInfo> }
    extern "system" fn cb(hwnd: sys::HWND, lparam: sys::LPARAM) -> sys::BOOL {
        unsafe {
            let ctx = &mut *(lparam as *mut Ctx);
            if sys::IsWindowVisible(hwnd) == 0 { return 1; }
            let mut pid: sys::DWORD = 0;
            sys::GetWindowThreadProcessId(hwnd, &mut pid);
            if !ctx.pids.contains(&pid) { return 1; }
            let len = sys::GetWindowTextLengthW(hwnd);
            if len <= 0 { return 1; }
            let mut buf = vec![0u16; (len as usize) + 1];
            let n = sys::GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if n <= 0 { return 1; }
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            ctx.found.push(WindowInfo { hwnd: hwnd as usize, title, visible: true });
        }
        1
    }
    let mut ctx = Ctx { pids, found: Vec::new() };
    unsafe { sys::EnumWindows(Some(cb), &mut ctx as *mut Ctx as sys::LPARAM); }
    ctx.found.into_iter().next()
        .ok_or_else(|| format!("找到「{app}」进程，但没有可用的可见窗口（可能已最小化到托盘）"))
}

#[cfg(not(windows))]
pub fn find_app_window(_app: &str) -> Result<WindowInfo, String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 统一入口：给定 app 名与 title，优先按 app 发现，失败再退回标题匹配。
pub fn resolve_window(app: &str, title: &str) -> Result<WindowInfo, String> {
    if !app.is_empty() {
        return find_app_window(app);
    }
    if !title.is_empty() {
        return find_window(title);
    }
    Err("请提供 --app（如 豆包）或 --title（窗口标题子串）".into())
}

/// 激活窗口。用 AttachThreadInput 附加前台线程，绕过 SetForegroundWindow 限制。
#[cfg(windows)]
pub fn activate_window(hwnd: usize) -> Result<(), String> {
    unsafe {
        let h = hwnd as sys::HWND;
        if sys::IsWindowVisible(h) == 0 {
            return Err("目标窗口不可见，请先恢复/显示窗口".into());
        }
        sys::ShowWindow(h, sys::SW_RESTORE);
        // 先给自己一次前台权限（AllowSetForegroundWindow(当前进程) 让系统放行）
        let fg = sys::GetForegroundWindow();
        let tid_fg = sys::GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let tid_target = sys::GetWindowThreadProcessId(h, std::ptr::null_mut());
        let tid_cur = sys::GetCurrentThreadId();
        let attached_fg = tid_fg != tid_cur && sys::AttachThreadInput(tid_cur, tid_fg, 1) != 0;
        let attached_target =
            tid_target != tid_cur && sys::AttachThreadInput(tid_cur, tid_target, 1) != 0;

        // 组合多种激活手段，提高成功率
        sys::SwitchToThisWindow(h, 1);
        sys::BringWindowToTop(h);
        sys::SetForegroundWindow(h);
        sys::SetFocus(h);
        sys::Sleep(200);
        // 若仍不是前台，再补一次（有些系统在Attach后才放行）
        if sys::GetForegroundWindow() != h {
            sys::SetForegroundWindow(h);
            sys::Sleep(200);
        }

        if attached_target {
            sys::AttachThreadInput(tid_cur, tid_target, 0);
        }
        if attached_fg {
            sys::AttachThreadInput(tid_cur, tid_fg, 0);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn activate_window(_hwnd: usize) -> Result<(), String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 写文本到系统剪贴板（Unicode）。调用方负责先 OpenClipboard。
#[cfg(windows)]
unsafe fn set_clipboard_text(text: &str) -> Result<(), String> {
    let wide = to_wide(text);
    let bytes = wide.len() * 2;
    let h = sys::GlobalAlloc(sys::GMEM_MOVEABLE, bytes);
    if h.is_null() {
        return Err("GlobalAlloc 失败".into());
    }
    let ptr = sys::GlobalLock(h) as *mut u16;
    if ptr.is_null() {
        return Err("GlobalLock 失败".into());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
    sys::GlobalUnlock(h);
    if sys::SetClipboardData(sys::CF_UNICODETEXT, h).is_null() {
        return Err(format!("SetClipboardData 失败: {}", sys::GetLastError()));
    }
    // 成功后剪贴板接管 hMem，不能再 GlobalFree
    Ok(())
}

#[cfg(windows)]
unsafe fn key(vk: u8, up: bool) {
    let flags = if up { sys::KEYEVENTF_KEYUP } else { 0 };
    // 关键修复：Electron/Chromium 走 RawInput，必须带真实扫描码，否则 keybd_event(bScan=0) 被忽略。
    let scan = sys::MapVirtualKeyW(vk as c_uint, sys::MAPVK_VK_TO_VSC) as u8;
    sys::keybd_event(vk, scan, flags, 0);
    sys::Sleep(40);
}

/// 记录一次按键组合：Ctrl+V，可选回车。
#[cfg(windows)]
unsafe fn paste_and_maybe_enter(press_enter: bool) {
    key(sys::VK_CONTROL, false);
    key(sys::VK_V, false);
    key(sys::VK_V, true);
    key(sys::VK_CONTROL, true);
    sys::Sleep(250); // 等 Electron 渲染层处理粘贴
    if press_enter {
        // 聊天窗口：Shift+Enter 有时是换行，这里用纯 Enter 发送
        key(sys::VK_RETURN, false);
        key(sys::VK_RETURN, true);
        sys::Sleep(150);
    }
}

/// 方式一（推荐，通用）：把文字写入剪贴板并粘贴到目标窗口输入框，可选回车发送。
/// 对豆包等 Electron 聊天窗口最稳。会覆盖剪贴板内容。
#[cfg(windows)]
pub fn send_text_paste(hwnd: usize, text: &str, press_enter: bool) -> Result<(), String> {
    activate_window(hwnd)?;
    unsafe {
        sys::Sleep(150);
        if sys::OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err(format!("OpenClipboard 失败: {}", sys::GetLastError()));
        }
        sys::EmptyClipboard();
        let r = set_clipboard_text(text);
        sys::CloseClipboard();
        r?;
        sys::Sleep(80);
        paste_and_maybe_enter(press_enter);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn send_text_paste(_hwnd: usize, _text: &str, _press_enter: bool) -> Result<(), String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 增强发送：激活 → 点击窗口底部输入框区域取得键盘焦点 → 剪贴板粘贴 → 可选回车。
/// 对豆包等 Electron 聊天窗口最稳：先点击确保焦点落在输入框，再粘贴。
#[cfg(windows)]
pub fn send_text_click_paste(
    hwnd: usize, text: &str, press_enter: bool, click_x_ratio: f64, click_y_ratio: f64,
) -> Result<(), String> {
    activate_window(hwnd)?;
    unsafe {
        let h = hwnd as sys::HWND;
        let mut rect: sys::RECT = std::mem::zeroed();
        sys::GetWindowRect(h, &mut rect);
        let w = (rect.right - rect.left) as f64;
        let hgt = (rect.bottom - rect.top) as f64;
        if w <= 0.0 || hgt <= 0.0 {
            return Err("窗口矩形无效".into());
        }
        // 点击窗口指定比例处取得输入框焦点。
        // 豆包桌面版(1679x845)聊天输入框中心约 (897,703)，即 x≈0.53、y≈0.83。
        // 注意：y 别超过 0.88，否则会点到「创建项目」等入口弹出模态框。
        let cx = rect.left + (w * click_x_ratio) as c_long;
        let cy = rect.top + (hgt * click_y_ratio) as c_long;
        sys::SetCursorPos(cx as c_int, cy as c_int);
        sys::Sleep(80);
        sys::mouse_event(sys::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        sys::Sleep(50);
        sys::mouse_event(sys::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        sys::Sleep(200);

        // 写剪贴板
        if sys::OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err(format!("OpenClipboard 失败: {}", sys::GetLastError()));
        }
        sys::EmptyClipboard();
        let r = set_clipboard_text(text);
        sys::CloseClipboard();
        r?;
        sys::Sleep(120);
        paste_and_maybe_enter(press_enter);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn send_text_click_paste(
    _hwnd: usize, _text: &str, _press_enter: bool, _click_x_ratio: f64, _click_y_ratio: f64,
) -> Result<(), String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 方式二：WM_COPYDATA 给支持它的窗口发送 UTF-8 文本（结构化、不动剪贴板）。
/// 返回 SendMessageTimeout 的 LRESULT，0 通常表示目标未处理。
#[cfg(windows)]
pub fn send_text_copydata(hwnd: usize, text: &str, timeout_ms: u32) -> Result<isize, String> {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(0);
    let mut cds = sys::COPYDATASTRUCT {
        dw_data: 0x53595041, // "SYPA" 自定义标记
        cb_data: bytes.len() as u32,
        lp_data: bytes.as_mut_ptr() as *mut c_void,
    };
    let mut result: usize = 0;
    let r = unsafe {
        sys::SendMessageTimeoutW(
            hwnd as sys::HWND,
            sys::WM_COPYDATA,
            0,
            &mut cds as *mut sys::COPYDATASTRUCT as sys::LPARAM,
            sys::SMTO_ABORTIFHUNG,
            timeout_ms,
            &mut result,
        )
    };
    Ok(r)
}

#[cfg(not(windows))]
pub fn send_text_copydata(_hwnd: usize, _text: &str, _timeout_ms: u32) -> Result<isize, String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 读取剪贴板纯文本（Unicode）。
#[cfg(windows)]
unsafe fn get_clipboard_text() -> Option<String> {
    if sys::OpenClipboard(std::ptr::null_mut()) == 0 {
        return None;
    }
    let h = sys::GetClipboardData(sys::CF_UNICODETEXT);
    if h.is_null() {
        sys::CloseClipboard();
        return None;
    }
    let ptr = sys::GlobalLock(h) as *const u16;
    let out = if ptr.is_null() {
        None
    } else {
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
            if len > 1_000_000 {
                break;
            }
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len)))
    };
    sys::GlobalUnlock(h);
    sys::CloseClipboard();
    out
}

#[cfg(windows)]
unsafe fn set_clipboard_raw_text(text: &str) {
    if sys::OpenClipboard(std::ptr::null_mut()) == 0 {
        return;
    }
    sys::EmptyClipboard();
    let _ = set_clipboard_text(text);
    sys::CloseClipboard();
}

/// 抓取目标窗口的全文：激活 → 保存剪贴板 → Ctrl+A/Ctrl+C → 读剪贴板 → 还原剪贴板。
/// 尽力而为：部分自绘/非文本窗口会失败或返回空。
#[cfg(windows)]
pub fn read_window_text(hwnd: usize, restore_clipboard: bool) -> Result<String, String> {
    activate_window(hwnd)?;
    unsafe {
        let seq_before = sys::GetClipboardSequenceNumber();
        let saved = get_clipboard_text();
        sys::Sleep(100);
        key(sys::VK_CONTROL, false);
        key(sys::VK_A, false);
        key(sys::VK_A, true);
        key(sys::VK_CONTROL, true);
        sys::Sleep(80);
        key(sys::VK_CONTROL, false);
        key(sys::VK_C, false);
        key(sys::VK_C, true);
        key(sys::VK_CONTROL, true);
        sys::Sleep(180);
        let grabbed = get_clipboard_text();
        if restore_clipboard && sys::GetClipboardSequenceNumber() != seq_before {
            if let Some(s) = saved {
                set_clipboard_raw_text(&s);
            }
        }
        grabbed.ok_or_else(|| "读取剪贴板失败".into())
    }
}

#[cfg(not(windows))]
pub fn read_window_text(_hwnd: usize, _restore_clipboard: bool) -> Result<String, String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 对比两份文本，返回新增的行（简单差异：新行中不在旧行集合里的部分，保留出现顺序）。
/// 用于把「窗口全文」转成「新消息」。
pub fn diff_new_lines(old: &str, new: &str, stateful: bool) -> Vec<String> {
    use std::collections::HashSet;
    let old_lines: Vec<&str> = old.lines().collect();
    let old_set: HashSet<&str> = old_lines.iter().copied().collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for line in new.lines() {
        let t = line.trim_end();
        if t.is_empty() {
            continue;
        }
        if stateful && old_set.contains(t) {
            continue;
        }
        if seen.insert(t.to_string()) {
            out.push(t.to_string());
        }
    }
    out
}

/// 便捷：查找 + 发送。app 为空则按 title 匹配；默认用「点击输入框+粘贴」方式（对 Electron 最稳）。
/// 返回 (目标窗口标题, 使用的方法)。
pub fn send_to_window(
    app: &str, title_contains: &str, text: &str, press_enter: bool, method: &str,
    click_x: f64, click_y: f64,
) -> Result<(String, String), String> {
    let w = resolve_window(app, title_contains)?;
    let used = if method == "click" || method.is_empty() {
        send_text_click_paste(w.hwnd, text, press_enter, click_x, click_y)?;
        "click-paste"
    } else if method == "copy" {
        send_text_copydata(w.hwnd, text, 2000).map(|_| ())?;
        "copydata"
    } else {
        send_text_paste(w.hwnd, text, press_enter)?;
        "paste"
    };
    Ok((w.title, used.to_string()))
}

/// 供 CLI 输出统一结构。
#[allow(dead_code)]
pub fn op_result(op: &str, ok: bool, extra: Value) -> Value {
    let mut v = json!({"module": "winmsg", "op": op, "ok": ok, "platform": std::env::consts::OS});
    if let Some(obj) = v.as_object_mut() {
        for (k, val) in extra.as_object().cloned().unwrap_or_default() {
            obj.insert(k, val);
        }
    }
    v
}
