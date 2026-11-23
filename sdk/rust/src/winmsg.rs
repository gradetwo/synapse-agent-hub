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
    pub const GA_ROOT: c_uint = 2;
    pub const SWP_NOSIZE: c_uint = 0x0001;
    pub const SWP_NOMOVE: c_uint = 0x0002;
    pub const SWP_SHOWWINDOW: c_uint = 0x0040;
    pub const HWND_TOPMOST: HWND = -1isize as HWND;
    pub const HWND_NOTOPMOST: HWND = -2isize as HWND;

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

    #[repr(C)]
    pub struct POINT {
        pub x: c_long,
        pub y: c_long,
    }

    pub type WndEnumProc = Option<extern "system" fn(HWND, LPARAM) -> BOOL>;

    #[link(name = "user32")]
    extern "system" {
        pub fn FindWindowW(lp_class_name: *const u16, lp_window_name: *const u16) -> HWND;
        pub fn EnumWindows(lp_enum_proc: WndEnumProc, l_param: LPARAM) -> BOOL;
        pub fn GetWindowTextLengthW(h_wnd: HWND) -> c_int;
        pub fn GetWindowTextW(h_wnd: HWND, lp_string: *mut u16, n_max_count: c_int) -> c_int;
        pub fn IsWindowVisible(h_wnd: HWND) -> BOOL;
        pub fn IsIconic(h_wnd: HWND) -> BOOL;
        pub fn GetForegroundWindow() -> HWND;
        pub fn SetForegroundWindow(h_wnd: HWND) -> BOOL;
        pub fn BringWindowToTop(h_wnd: HWND) -> BOOL;
        pub fn SetFocus(h_wnd: HWND) -> HWND;
        pub fn ShowWindow(h_wnd: HWND, n_cmd_show: c_int) -> BOOL;
        pub fn SetWindowPos(
            h_wnd: HWND, h_wnd_insert_after: HWND, x: c_int, y: c_int,
            cx: c_int, cy: c_int, u_flags: c_uint,
        ) -> BOOL;
        pub fn WindowFromPoint(point: POINT) -> HWND;
        pub fn GetAncestor(h_wnd: HWND, ga_flags: c_uint) -> HWND;
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

#[cfg(windows)]
mod uia {
    use std::os::raw::c_long;
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
        TreeScope_Descendants, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
        UIA_GroupControlTypeId, UIA_HyperlinkControlTypeId, UIA_PaneControlTypeId,
        UIA_TextControlTypeId, UIA_TextPatternId, UIA_ValuePatternId, IUIAutomationTextPattern,
    };

    /// 找 composer 控件本身，供“取矩形”和“读输入框内容”共用同一套评分，
    /// 避免两次查找选中不同控件（一次点击搜索框、一次读正文）。
    ///
    /// 首次查找时窗口可能还在恢复/重排（豆包启动、切会话、刚激活），UIA 树里
    /// 暂时没有 composer；这里做短重试，避免直接掉到固定坐标兜底。
    fn find_composer(hwnd: usize) -> Option<(IUIAutomationElement, (i32, i32, i32, i32))> {
        for attempt in 0..6 {
            if let Some(result) = find_composer_once(hwnd) {
                return Some(result);
            }
            if attempt < 5 {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        None
    }

    fn find_composer_once(hwnd: usize) -> Option<(IUIAutomationElement, (i32, i32, i32, i32))> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let root = automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void)).ok()?;
            let condition = automation.CreateTrueCondition().ok()?;
            let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
            let count = elements.Length().ok()?;

            let mut wr = super::sys::RECT::default();
            super::sys::GetWindowRect(hwnd as super::sys::HWND, &mut wr);
            let win_w = (wr.right - wr.left) as i32;
            let win_h = (wr.bottom - wr.top) as i32;

            let mut best: Option<(i32, IUIAutomationElement, (i32, i32, i32, i32))> = None;
            for i in 0..count {
                let Ok(el) = elements.GetElement(i) else { continue };
                let Ok(ct) = el.CurrentControlType() else { continue };
                let class_name = el.CurrentClassName().map(|s| s.to_string()).unwrap_or_default();
                let lower_class = class_name.to_lowercase();
                // 豆包的 composer 不是 Edit/Document，而是一个 Group：
                // name=doc_editor，class 含 input-content-container，位于窗口底部。
                // WorkBuddy 等 Electron 应用也常把 contenteditable 暴露成 Group/Pane，
                // 所以对这类“输入容器”单独识别，不能只认 Edit。
                let class_looks_like_composer = [
                    "input-content", "composer", "chat-input", "chatinput",
                    "message-input", "prompt-input", "editor-input", "input-container",
                    "tiptap", "prosemirror", "contenteditable", "text-input",
                ].iter().any(|x| lower_class.contains(x));
                let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                let lower = name.to_lowercase();
                // Group/Pane 只有两种进入候选：
                // 1) class 像输入容器（input-content / tiptap / ProseMirror ...）；
                // 2) name 明确是 doc_editor。
                // 之前只放行外层 input-content，内层 tiptap 被过滤；豆包切换会话时
                // 外层容器可能暂时不在 UIA 树里，内层就是唯一可用落点。
                let composer_class_or_name = class_looks_like_composer || lower.contains("doc_editor");
                let is_input_container = ct == UIA_GroupControlTypeId || ct == UIA_PaneControlTypeId;
                // 只有 Edit/Document 或真正的输入容器才能进候选。若放开到所有控件类型，
                // 某些消息气泡/按钮只要 class 命中 "contenteditable" 也会被当成 composer。
                if ct != UIA_EditControlTypeId && ct != UIA_DocumentControlTypeId
                    && !(is_input_container && composer_class_or_name) {
                    continue;
                }
                if let Ok(off) = el.CurrentIsOffscreen() {
                    if off.as_bool() { continue; }
                }
                if let Ok(enabled) = el.CurrentIsEnabled() {
                    if !enabled.as_bool() { continue; }
                }
                let Ok(r) = el.CurrentBoundingRectangle() else { continue };
                let w = r.right - r.left;
                let h = r.bottom - r.top;
                // tiptap/ProseMirror 的编辑区常常只有一行 24px 高，不能按 36px 一刀切；
                // 但必须仍然有足够宽度，避免把工具栏小按钮当成输入框。
                let min_h = if class_looks_like_composer { 18 } else { 36 };
                if w < 160 || h < min_h {
                    continue;
                }
                let editor_like = ["tiptap", "prosemirror", "contenteditable"]
                    .iter().any(|x| lower_class.contains(x));
                let in_input_container = lower_class.contains("input-content");
                // 已发送的聊天气泡也可能带 tiptap/ProseMirror，并且很长；真正的 composer
                // 外层带 input-content-container，内部编辑区只有一行到几行，不会是高块。
                if h > 180 && editor_like && !in_input_container {
                    continue;
                }
                let focusable = el.CurrentIsKeyboardFocusable().map(|b| b.as_bool()).unwrap_or(false);
                // 聊天正文是 Document，通常占满大半窗口；composer 一般不超过 320px。
                // 但记事本等原生 Edit 会占满窗口，不能一刀切排除，否则连普通 Edit 都找不到。
                if ct == UIA_DocumentControlTypeId && h > 320 && !class_looks_like_composer {
                    continue;
                }
                // 整个网页根 Document：宽高接近窗口，不能当输入框。
                if w >= win_w.saturating_mul(9) / 10 && h >= win_h.saturating_mul(2) / 3 {
                    continue;
                }
                let mut score = if ct == UIA_EditControlTypeId { 8 } else { 2 };
                if class_looks_like_composer { score += 16; }
                // 真正的 composer 在 input-content-container 里；消息气泡没有这个祖先，
                // 给输入容器加权，避免聊天记录一多就把气泡当成输入框。
                if in_input_container { score += 12; }
                // 深层的 tiptap/ProseMirror 才是真正接收键盘的编辑区；外层只是带边框的容器。
                if ["tiptap", "prosemirror", "contenteditable"].iter()
                    .any(|x| lower_class.contains(x)) { score += 10; }
                if lower.contains("doc_editor") { score += 6; }
                if focusable { score += 6; }
                if h >= 60 { score += 4; } else if h >= 40 { score += 1; }
                if w >= 300 { score += 2; }
                if h >= 18 && r.bottom >= wr.bottom - 160 { score += 6; }
                if r.top >= wr.top + 30 { score += 1; }
                if ["输入", "发送", "消息", "message", "composer", "chat", "ask"]
                    .iter().any(|x| lower.contains(x)) { score += 2; }
                if ["搜索", "search"].iter().any(|x| lower.contains(x)) { score -= 20; }
                if score <= 0 { continue; }
                if best.as_ref().map(|(s, _, _)| score > *s).unwrap_or(true) {
                    eprintln!(
                        "[uia] candidate score={score} type={ct:?} name={name:?} class={:?} rect=({},{},{},{}) focus={focusable}",
                        class_name.chars().take(100).collect::<String>(),
                        r.left, r.top, r.right, r.bottom
                    );
                    best = Some((score, el, (r.left, r.top, r.right, r.bottom)));
                }
            }
            best.map(|(_, el, rect)| (el, rect))
        }
    }

    /// 用 UI Automation 找“聊天输入框”的屏幕矩形。
    /// 不绑定豆包/WorkBuddy 的标题或固定比例：优先 Edit，其次 Document，
    /// 排除全窗口根 Document、搜索框和不可见控件。
    pub fn find_input_rect(hwnd: usize) -> Option<(i32, i32, i32, i32)> {
        find_composer(hwnd).map(|(_, rect)| rect)
    }

    /// 读当前 composer 里的值。ValuePattern 是判断“文字真的进输入框”的最可靠证据；
    /// 不支持 ValuePattern 的 Electron 控件返回 None，由调用方明确标记为“未验证”，
    /// 不能假装成功。
    pub fn input_value(hwnd: usize) -> Option<String> {
        unsafe {
            let (el, _) = find_composer(hwnd)?;
            let pattern: IUIAutomationValuePattern =
                el.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
            pattern.CurrentValue().ok().map(|v| v.to_string())
        }
    }

    /// 只读 composer 内部的文字节点，不按 Ctrl+A/C 读整个页面。
    /// 豆包在回车后会收起 composer，此时 Ctrl+A/C 会选中整段对话并包含刚发的
    /// 标记文本，造成“仍留在输入框”的假阴性；tiptap/ProseMirror 的 Text 子节点
    /// 才是真实输入内容。WorkBuddy 的 Edit 没有 Text 子节点，返回 None 由调用方回退。
    pub fn composer_text(hwnd: usize) -> Option<String> {
        unsafe {
            let (el, _) = find_composer(hwnd)?;
            // 优先用 TextPattern：Chromium 的 contenteditable 即使没有 Text 子节点，
            // TextPattern 也能直接读出输入区文字，WorkBuddy 的匿名 Edit 就靠它。
            if let Ok(pattern) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                if let Ok(range) = pattern.DocumentRange() {
                    if let Ok(text) = range.GetText(-1) {
                        return Some(text.to_string());
                    }
                }
            }
            let class = el.CurrentClassName().map(|s| s.to_string()).unwrap_or_default();
            let lower = class.to_lowercase();
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let condition = automation.CreateTrueCondition().ok()?;
            let children = el.FindAll(TreeScope_Descendants, &condition).ok()?;
            let count = children.Length().ok()?;
            let mut text = String::new();
            let mut found = false;
            for i in 0..count {
                let Ok(child) = children.GetElement(i) else { continue };
                if child.CurrentControlType().ok() != Some(UIA_TextControlTypeId) {
                    continue;
                }
                found = true;
                if let Ok(name) = child.CurrentName() {
                    text.push_str(&name.to_string());
                }
            }
            if found {
                Some(text)
            } else if lower.contains("tiptap") || lower.contains("prosemirror") {
                // tiptap 为空时没有 Text 子节点；它本身就是输入区，空即空。
                Some(String::new())
            } else {
                None
            }
        }
    }

    /// 读窗口正文（聊天记录）的文本，用于重试前去重：同一条消息如果已经上屏，
    /// 即使上一轮回读失败、没有打上 _window_delivered，也不能再粘贴一次。
    /// 只读 UIA TextPattern，不动剪贴板、不选正文。
    pub fn document_text(hwnd: usize) -> Option<String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let root = automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void)).ok()?;
            if let Ok(pattern) = root.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                if let Ok(range) = pattern.DocumentRange() {
                    if let Ok(text) = range.GetText(-1) {
                        let s = text.to_string();
                        if !s.trim().is_empty() { return Some(s); }
                    }
                }
            }
            let condition = automation.CreateTrueCondition().ok()?;
            let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
            let count = elements.Length().ok()?;
            for i in 0..count {
                let Ok(el) = elements.GetElement(i) else { continue };
                if el.CurrentControlType().ok() != Some(UIA_DocumentControlTypeId) { continue; }
                if let Ok(pattern) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                    if let Ok(range) = pattern.DocumentRange() {
                        if let Ok(text) = range.GetText(-1) {
                            let s = text.to_string();
                            if !s.trim().is_empty() { return Some(s); }
                        }
                    }
                }
            }
            None
        }
    }

    /// 诊断用：列出所有 Edit/Document/Group/Pane 的 UIA 属性。
    /// WorkBuddy 的编辑控件可能没有 Name/ClassName，必须看实际矩形和焦点才能定位。
    pub fn dump(hwnd: usize) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(automation): Result<IUIAutomation, _> =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else { return out };
            let Ok(root) = automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void)) else { return out };
            let Ok(condition) = automation.CreateTrueCondition() else { return out };
            let Ok(elements) = root.FindAll(TreeScope_Descendants, &condition) else { return out };
            let Ok(count) = elements.Length() else { return out };
            for i in 0..count {
                let Ok(el) = elements.GetElement(i) else { continue };
                let Ok(ct) = el.CurrentControlType() else { continue };
                if ct != UIA_EditControlTypeId && ct != UIA_DocumentControlTypeId
                    && ct != UIA_GroupControlTypeId && ct != UIA_PaneControlTypeId {
                    continue;
                }
                let Ok(r) = el.CurrentBoundingRectangle() else { continue };
                if r.right - r.left < 80 || r.bottom - r.top < 10 { continue; }
                let clickable = {
                    let mut p = windows::Win32::Foundation::POINT::default();
                    el.GetClickablePoint(&mut p).ok().map(|_| [p.x, p.y])
                };
                out.push(serde_json::json!({
                    "type": format!("{ct:?}"),
                    "name": el.CurrentName().map(|s| s.to_string()).unwrap_or_default(),
                    "class": el.CurrentClassName().map(|s| s.to_string()).unwrap_or_default(),
                    "rect": [r.left, r.top, r.right, r.bottom],
                    "clickable": clickable,
                    "focus": el.CurrentIsKeyboardFocusable().map(|b| b.as_bool()).unwrap_or(false),
                    "has_focus": el.CurrentHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
                    "offscreen": el.CurrentIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
                }));
            }
        }
        out
    }

    /// 当前活动会话标题。豆包的顶层 Document 名称形如
    /// `◆dou-win-133 - 豆包`，取 ` - ` 左侧；找不到时退回顶部居中 Text。
    fn current_conversation_title(hwnd: usize) -> Option<String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let root = automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void)).ok()?;
            let condition = automation.CreateTrueCondition().ok()?;
            let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
            let count = elements.Length().ok()?;

            for i in 0..count {
                let Ok(el) = elements.GetElement(i) else { continue };
                if el.CurrentControlType().ok() != Some(UIA_DocumentControlTypeId) { continue; }
                let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                if let Some(pos) = name.rfind(" - ") {
                    let prefix = name[..pos].trim();
                    if !prefix.is_empty() {
                        return Some(prefix.to_string());
                    }
                }
            }

            // 兼容没有 Document 名称的应用：顶部标题文本（用窗口中心附近过滤掉侧栏）。
            let mut wr = super::sys::RECT::default();
            super::sys::GetWindowRect(hwnd as super::sys::HWND, &mut wr);
            let win_w = (wr.right - wr.left) as i32;
            let win_center = wr.left + win_w / 2;
            let mut best: Option<(i32, String)> = None;
            for i in 0..count {
                let Ok(el) = elements.GetElement(i) else { continue };
                if el.CurrentControlType().ok() != Some(UIA_TextControlTypeId) { continue; }
                if el.CurrentIsOffscreen().map(|b| b.as_bool()).unwrap_or(true) { continue; }
                let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                if name.trim().is_empty() { continue; }
                let Ok(r) = el.CurrentBoundingRectangle() else { continue };
                let h = r.bottom - r.top;
                let w = r.right - r.left;
                if h < 14 || h > 60 || w < 40 || w > 600 { continue; }
                if r.top > wr.top + 180 || r.bottom < wr.top + 40 { continue; }
                let center = (r.left + r.right) / 2;
                let dist = (center - win_center).abs();
                if dist > 400 { continue; }
                if best.as_ref().map(|(d, _)| dist < *d).unwrap_or(true) {
                    best = Some((dist, name));
                }
            }
            best.map(|(_, name)| name)
        }
    }

    /// 确保目标会话是当前活动会话：
    /// 1) 已匹配则直接返回；
    /// 2) 未匹配时在左侧会话列表找 name 含 `want` 的 Hyperlink（class 含 conversation-item），
    ///    点击它并等标题变化；
    /// 3) 找不到/切换失败时返回错误，由调用方保留 WAL、不 ACK，绝不能把消息投进错误会话。
    pub fn ensure_conversation(hwnd: usize, want: &str) -> Result<(), String> {
        let want = want.trim();
        if want.is_empty() {
            return Ok(());
        }
        super::activate_window(hwnd)?;
        if let Some(current) = current_conversation_title(hwnd) {
            if current.contains(want) {
                eprintln!("[conversation] 当前会话已匹配：{current:?}");
                return Ok(());
            }
            eprintln!("[conversation] 当前会话={current:?}，目标={want:?}，准备从会话列表切换");
        } else {
            eprintln!("[conversation] 无法读取当前会话标题，目标={want:?}，仍尝试从会话列表切换");
        }

        let click_pos = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("创建 UIAutomation 失败：{e}"))?;
            let root = automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void))
                .map_err(|e| format!("取窗口 UIA 根失败：{e}"))?;
            let condition = automation.CreateTrueCondition()
                .map_err(|e| format!("创建 UIA 条件失败：{e}"))?;
            let elements = root.FindAll(TreeScope_Descendants, &condition)
                .map_err(|e| format!("枚举 UIA 控件失败：{e}"))?;
            let count = elements.Length().map_err(|e| format!("读取 UIA 控件数失败：{e}"))?;
            let mut hit: Option<(i32, i32, String)> = None;
            for i in 0..count {
                let Ok(el) = elements.GetElement(i) else { continue };
                if el.CurrentControlType().ok() != Some(UIA_HyperlinkControlTypeId) { continue; }
                let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                let class = el.CurrentClassName().map(|s| s.to_string()).unwrap_or_default();
                if !name.contains(want) || !class.contains("conversation-item") { continue; }
                if el.CurrentIsOffscreen().map(|b| b.as_bool()).unwrap_or(false) { continue; }
                let Ok(r) = el.CurrentBoundingRectangle() else { continue };
                if r.right - r.left < 80 || r.bottom - r.top < 18 { continue; }
                let mut p = POINT::default();
                let point = el.GetClickablePoint(&mut p).ok()
                    .map(|_| (p.x, p.y))
                    .unwrap_or(((r.left + r.right) / 2, (r.top + r.bottom) / 2));
                hit = Some((point.0, point.1, name));
                break;
            }
            hit
        };

        let Some((x, y, name)) = click_pos else {
            return Err(format!("会话列表中没有找到包含 {want:?} 的 conversation-item"));
        };
        eprintln!("[conversation] 点击会话 {name:?} @({x},{y})");
        unsafe {
            let h = hwnd as super::sys::HWND;
            let pt = super::sys::POINT { x: x as c_long, y: y as c_long };
            let hit = super::sys::WindowFromPoint(pt);
            if hit.is_null() || super::sys::GetAncestor(hit, super::sys::GA_ROOT) != h {
                return Err(format!("会话列表点击坐标被其它窗口遮挡（hit hwnd={:#x}）", hit as usize));
            }
            super::sys::SetCursorPos(x, y);
            super::sys::Sleep(80);
            super::sys::mouse_event(super::sys::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
            super::sys::Sleep(50);
            super::sys::mouse_event(super::sys::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        }

        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if current_conversation_title(hwnd).map(|s| s.contains(want)).unwrap_or(false) {
                eprintln!("[conversation] 已切换到目标会话：{want:?}");
                return Ok(());
            }
        }
        let current = current_conversation_title(hwnd).unwrap_or_else(|| "<unknown>".into());
        Err(format!("点击会话后仍未匹配目标标题：当前={current:?} 目标={want:?}"))
    }

    /// 当前键盘焦点是否已经在 composer 上。Electron 应用（WorkBuddy）打开欢迎页时
    /// 会自动聚焦输入框，此时再按 UIA 矩形点一次反而可能点到建议按钮，必须先读焦点。
    pub(super) fn input_has_focus(hwnd: usize) -> bool {
        let Some((el, _)) = find_composer(hwnd) else { return false };
        unsafe { el.CurrentHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false) }
    }
}

#[cfg(not(windows))]
mod uia {
    pub fn find_input_rect(_hwnd: usize) -> Option<(i32, i32, i32, i32)> { None }
    pub fn input_value(_hwnd: usize) -> Option<String> { None }
    pub fn ensure_conversation(_hwnd: usize, _want: &str) -> Result<(), String> {
        Err("窗口桥仅在 Windows 上可用".into())
    }
}

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

    // 2) 枚举顶层窗口，取属于这些 PID 的可见窗口，并优先最大的主窗口。
    //    豆包/输入法会额外创建 CandidateWindow、IME 等小窗口；按“第一个匹配”会点错。
    struct Ctx { pids: std::collections::HashSet<u32>, found: Vec<(i64, WindowInfo)> }
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
            let lower = title.to_lowercase();
            if ["candidatewindow", "msctfime ui", "default ime", "gdi+ window"]
                .iter().any(|x| lower.contains(x)) {
                return 1;
            }
            let mut r: sys::RECT = std::mem::zeroed();
            sys::GetWindowRect(hwnd, &mut r);
            let w = (r.right - r.left).max(0) as i64;
            let h = (r.bottom - r.top).max(0) as i64;
            // 输入法候选框/托盘提示通常只有几十像素；主聊天窗口至少 300x200。
            if w < 300 || h < 200 { return 1; }
            ctx.found.push((w * h, WindowInfo { hwnd: hwnd as usize, title, visible: true }));
        }
        1
    }
    let mut ctx = Ctx { pids, found: Vec::new() };
    unsafe { sys::EnumWindows(Some(cb), &mut ctx as *mut Ctx as sys::LPARAM); }
    ctx.found.sort_by_key(|(area, _)| -*area);
    ctx.found.into_iter().map(|(_, w)| w).next()
        .ok_or_else(|| format!("找到「{app}」进程，但没有可用的可见主窗口（可能已最小化到托盘）"))
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

/// 激活窗口，并校验它真的成为前台窗口。
///
/// Windows 的 `SetForegroundWindow` 受前台锁限制：后台进程调用可能返回失败，
/// 但窗口仍留在后面。这里先附加到当前前台线程取得输入队列，再用 `SetWindowPos`
/// 短暂置顶兜底，最后必须用 `GetForegroundWindow` 验证。验证失败时直接返回错误，
/// 避免后续 `mouse_event`/`keybd_event` 把文字送进前台终端或其它窗口。
#[cfg(windows)]
pub fn activate_window(hwnd: usize) -> Result<(), String> {
    unsafe {
        let h = hwnd as sys::HWND;
        if sys::IsWindowVisible(h) == 0 {
            return Err("目标窗口不可见，请先恢复/显示窗口".into());
        }
        if sys::IsIconic(h) != 0 {
            sys::ShowWindow(h, sys::SW_RESTORE);
            sys::Sleep(120);
        }
        if sys::GetForegroundWindow() == h {
            return Ok(());
        }

        let fg = sys::GetForegroundWindow();
        let tid_fg = sys::GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let tid_target = sys::GetWindowThreadProcessId(h, std::ptr::null_mut());
        let tid_cur = sys::GetCurrentThreadId();
        let attached_fg = tid_fg != tid_cur && sys::AttachThreadInput(tid_cur, tid_fg, 1) != 0;

        // 先附加到前台线程，这是绕过前台锁的关键；附加目标线程只用于 SetFocus。
        sys::SwitchToThisWindow(h, 1);
        sys::BringWindowToTop(h);
        sys::SetForegroundWindow(h);
        sys::Sleep(180);
        if sys::GetForegroundWindow() != h {
            // 前台锁偶尔仍不放行：短暂置顶再撤销，通常能完成激活。
            sys::SetWindowPos(
                h,
                sys::HWND_TOPMOST,
                0,
                0,
                0,
                0,
                sys::SWP_NOMOVE | sys::SWP_NOSIZE | sys::SWP_SHOWWINDOW,
            );
            sys::SetForegroundWindow(h);
            sys::SetWindowPos(
                h,
                sys::HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                sys::SWP_NOMOVE | sys::SWP_NOSIZE | sys::SWP_SHOWWINDOW,
            );
            sys::Sleep(180);
        }

        let attached_target =
            tid_target != tid_cur && sys::AttachThreadInput(tid_cur, tid_target, 1) != 0;
        if attached_target {
            sys::SetFocus(h);
        }
        if attached_target {
            sys::AttachThreadInput(tid_cur, tid_target, 0);
        }
        if attached_fg {
            sys::AttachThreadInput(tid_cur, tid_fg, 0);
        }

        if sys::GetForegroundWindow() != h {
            let current = sys::GetForegroundWindow() as usize;
            return Err(format!(
                "目标窗口未能切到前台（hwnd={hwnd:#x}，当前前台 hwnd={current:#x}）。\
                 可能被 Windows 前台锁、管理员权限差异或全屏窗口拦截；\
                 请先手动点一下目标窗口，或在同一权限级别下运行 agent 后重试。"
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn activate_window(_hwnd: usize) -> Result<(), String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 确保目标会话是当前活动会话。Windows 上用 UIA 读标题并点击左侧会话项；
/// 非 Windows 直接返回不支持。
pub fn ensure_conversation(hwnd: usize, want: &str) -> Result<(), String> {
    uia::ensure_conversation(hwnd, want)
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
        enter_key();
    }
}

#[cfg(windows)]
unsafe fn enter_key() {
    // 聊天窗口：Shift+Enter 有时是换行，这里用纯 Enter 发送
    key(sys::VK_RETURN, false);
    key(sys::VK_RETURN, true);
    sys::Sleep(150);
}

/// 方式一（推荐，通用）：把文字写入剪贴板并粘贴到目标窗口输入框，可选回车发送。
/// 对豆包等 Electron 聊天窗口最稳。会覆盖剪贴板内容。
#[cfg(windows)]
pub fn send_text_paste(hwnd: usize, text: &str, press_enter: bool) -> Result<(), String> {
    activate_window(hwnd)?;
    unsafe {
        let h = hwnd as sys::HWND;
        if sys::GetForegroundWindow() != h {
            return Err("目标窗口不是前台窗口，已中止粘贴".into());
        }
        sys::Sleep(150);
        if sys::OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err(format!("OpenClipboard 失败: {}", sys::GetLastError()));
        }
        sys::EmptyClipboard();
        let r = set_clipboard_text(text);
        sys::CloseClipboard();
        r?;
        sys::Sleep(80);
        if sys::GetForegroundWindow() != h {
            return Err("写入剪贴板后目标窗口失去前台，已中止粘贴".into());
        }
        paste_and_maybe_enter(press_enter);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn send_text_paste(_hwnd: usize, _text: &str, _press_enter: bool) -> Result<(), String> {
    Err("窗口桥仅在 Windows 上可用".into())
}

/// 公开的 UIA 输入框探测，供 run 日志/诊断使用。
#[cfg(windows)]
pub fn find_input_rect(hwnd: usize) -> Option<(i32, i32, i32, i32)> {
    uia::find_input_rect(hwnd)
}

#[cfg(windows)]
pub fn composer_text(hwnd: usize) -> Option<String> {
    uia::composer_text(hwnd)
}

#[cfg(not(windows))]
pub fn composer_text(_hwnd: usize) -> Option<String> {
    None
}

#[cfg(windows)]
pub fn document_text(hwnd: usize) -> Option<String> {
    uia::document_text(hwnd)
}

#[cfg(not(windows))]
pub fn document_text(_hwnd: usize) -> Option<String> {
    None
}

#[cfg(windows)]
pub fn input_has_focus(hwnd: usize) -> bool {
    uia::input_has_focus(hwnd)
}

#[cfg(not(windows))]
pub fn input_has_focus(_hwnd: usize) -> bool {
    false
}

#[cfg(windows)]
pub fn foreground_hwnd() -> usize {
    unsafe { sys::GetForegroundWindow() as usize }
}

#[cfg(not(windows))]
pub fn foreground_hwnd() -> usize {
    0
}

#[cfg(windows)]
pub fn dump_uia(hwnd: usize) -> Vec<Value> {
    uia::dump(hwnd)
}

#[cfg(not(windows))]
pub fn dump_uia(_hwnd: usize) -> Vec<Value> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn find_input_rect(_hwnd: usize) -> Option<(i32, i32, i32, i32)> {
    None
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
        // 再校验一次：activate_window 返回成功后，前台窗口仍可能被系统抢走。
        if sys::GetForegroundWindow() != h {
            return Err("目标窗口不是前台窗口，已中止点击，避免把文字发到其它窗口".into());
        }
        let mut rect: sys::RECT = std::mem::zeroed();
        sys::GetWindowRect(h, &mut rect);
        let w = (rect.right - rect.left) as f64;
        let hgt = (rect.bottom - rect.top) as f64;
        if w <= 0.0 || hgt <= 0.0 {
            return Err("窗口矩形无效".into());
        }
        // 优先用 UI Automation 找真正的输入控件；豆包、WorkBuddy 等 Electron
        // 窗口尺寸/滚动一变化，固定比例就会点到正文，所以比例只做兜底。
        let (cx, cy) = match uia::find_input_rect(hwnd) {
            Some((l, t, r, b)) if r > l && b > t => {
                eprintln!("[winmsg] UIA 输入框 rect=({l},{t},{r},{b})");
                let h = b - t;
                // 豆包的 doc_editor 可能把聊天正文和输入区都包进同一个矩形；
                // 点垂直中心会点到上方的消息气泡。输入区永远在底部，偏下点击。
                let cy = if h > 100 { b - 30 } else { (t + b) / 2 };
                (((l + r) / 2) as c_long, cy as c_long)
            }
            _ => {
                // 豆包当前窗口的 composer 在窗口底部（实测 hwnd 722318 时约 607-707，
                // 窗口高 723）；0.83 比例会点在上方的消息正文，输入框反而没有焦点。
                // 回退改成从窗口底边往上 80px，仍保留 x 比例给不同布局。
                eprintln!("[winmsg] UIA 未找到输入框，回退窗口底部输入区 (x_ratio={click_x_ratio}, y=bottom-80)");
                let fallback_cy = if hgt >= 240.0 {
                    rect.bottom - 80
                } else {
                    rect.top + (hgt * click_y_ratio) as c_long
                };
                (
                    rect.left + (w * click_x_ratio) as c_long,
                    fallback_cy,
                )
            }
        };
        // 关键：鼠标是全局的。如果目标窗口被终端等窗口挡住，单纯 SetCursorPos
        // 会把点击送给挡住它的窗口。点击前必须确认该坐标所属顶层窗口就是目标。
        let hit = sys::WindowFromPoint(sys::POINT { x: cx, y: cy });
        if hit.is_null() || sys::GetAncestor(hit, sys::GA_ROOT) != h {
            return Err(format!(
                "点击坐标被其它窗口遮挡（hit hwnd={:#x}）。已中止发送，避免把文字送进前台终端；请先把目标窗口切到前台。",
                hit as usize
            ));
        }
        sys::SetCursorPos(cx as c_int, cy as c_int);
        sys::Sleep(80);
        sys::mouse_event(sys::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        sys::Sleep(50);
        sys::mouse_event(sys::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        sys::Sleep(200);
        if sys::GetForegroundWindow() != h {
            return Err("点击后目标窗口失去前台，已中止粘贴".into());
        }

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

/// 发送并验证：先粘贴不回车，读 composer 的 ValuePattern，确认文本真的进了输入框，
/// 再按回车，并确认输入框被清空。返回 `true` 表示 ValuePattern 验证通过；
/// `false` 表示控件不支持 ValuePattern、只能确认粘贴动作已执行（日志会明确写“未验证”），
/// 不会把“只点了鼠标”冒充成已送达。
#[cfg(windows)]
pub fn send_text_click_paste_checked(
    hwnd: usize, text: &str, press_enter: bool, click_x_ratio: f64, click_y_ratio: f64,
) -> Result<bool, String> {
    // 去重标记取消息头部的方括号标签（如 [Synapse #551]），不要取前 24 个字符：
    // format_hub_message 会在标签后换行/拼接标题，按 24 字符截取会跨行，UIA 正文里
    // 往往匹配不到，重试时就会漏掉“已经上屏”的判断。
    let trimmed = text.trim();
    let marker: String = if let Some(end) = trimmed.find(']') {
        trimmed[..=end].trim().to_string()
    } else {
        trimmed.chars().take(24).collect()
    };
    if marker.is_empty() {
        return Err("待发送文本为空".into());
    }

    // 重试/崩溃恢复的第一道闸：正文里已经有这条 marker，就绝不再粘贴。
    // composer 里出现 marker 只算草稿，不能当成已上屏。
    let composer_now = uia::composer_text(hwnd).unwrap_or_default();
    let value_now = uia::input_value(hwnd).unwrap_or_default();
    // 这里不能用“composer 里有没有 marker”直接判草稿：豆包的聊天正文和输入区
    // 都可能被 UIA 归到同一个 doc_editor 容器里。用出现次数区分：
    // 正文次数 > 容器次数，说明至少有一条已经在聊天记录里，属于重复投递。
    let composer_count = composer_now.matches(&marker).count()
        .max(value_now.matches(&marker).count());
    let doc_before = uia::document_text(hwnd);
    let doc_before_count = doc_before.as_deref()
        .map(|d| d.matches(&marker).count()).unwrap_or(0);
    if doc_before_count > composer_count {
        eprintln!("[winmsg] 正文已含 {marker:?}（document={doc_before_count} > composer={composer_count}），判定已投递，跳过重复粘贴");
        return Ok(true);
    }

    let had_value = uia::input_value(hwnd);
    // 豆包/tiptap 这类没有 ValuePattern 的 composer，改用 UIA Text 子节点读输入区；
    // 不能用 Ctrl+A/C 读整页（回车后会把已发送的对话正文也选中，误判为没发出去）。
    let direct_text = uia::composer_text(hwnd).is_some();
    let already_focused = uia::input_has_focus(hwnd);
    eprintln!("[winmsg] composer 读取方式：value_pattern={} uia_text={} focused={}",
              had_value.is_some(), direct_text, already_focused);
    if already_focused {
        // WorkBuddy 欢迎页会自己把光标放进 composer；UIA 的矩形在部分 Electron
        // 页面是旧布局坐标，再点一次可能点到上方建议按钮，所以有焦点就直接粘贴。
        eprintln!("[winmsg] composer 已有键盘焦点，跳过点击，直接粘贴");
        send_text_paste(hwnd, text, false)?;
    } else {
        send_text_click_paste(hwnd, text, false, click_x_ratio, click_y_ratio)?;
    }
    let mut entered = false;
    if had_value.is_some() {
        for _ in 0..30 {
            if uia::input_value(hwnd).map(|v| v.contains(&marker)).unwrap_or(false) {
                entered = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    } else if direct_text {
        for _ in 0..20 {
            if uia::composer_text(hwnd).map(|t| t.contains(&marker)).unwrap_or(false) {
                entered = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    } else {
        // 豆包 composer 是 Group，没有 ValuePattern；用“点击后 Ctrl+A/C”读 composer。
        // 如果点击落到了聊天正文，读到的正文不含本条 seq 标记，验证会失败，
        // 不会再把“只点了鼠标”当成已投递。
        for _ in 0..20 {
            if read_window_text(hwnd, true).map(|t| t.contains(&marker)).unwrap_or(false) {
                entered = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }
    if !entered {
        // 豆包实测：粘贴动作可能直接触发提交，composer 随即清空/收起，
        // 此时 input_value/composer_text 都读不到 marker，但正文已经多了一条。
        // 如果只看 composer 就会误判失败并重投，造成同一消息重复上屏。
        let doc_after_count = uia::document_text(hwnd)
            .map(|d| d.matches(&marker).count()).unwrap_or(0);
        if doc_after_count > doc_before_count {
            let composer_after = uia::composer_text(hwnd).unwrap_or_default();
            let value_after = uia::input_value(hwnd).unwrap_or_default();
            if !composer_after.contains(&marker) && !value_after.contains(&marker) {
                eprintln!("[winmsg] composer 读不到 {marker:?}，但正文新增了该标记，判定已上屏");
                return Ok(true);
            }
        }
        return Err("粘贴后输入框没有出现预期文本：点击没有把焦点送进 composer".into());
    }
    if !press_enter {
        return Ok(had_value.is_some() || direct_text);
    }

    // 回车前最后确认目标窗口仍是前台，避免把 Enter 送到别的窗口。
    unsafe {
        if sys::GetForegroundWindow() != hwnd as sys::HWND {
            return Err("回车前目标窗口不是前台，已中止发送".into());
        }
        enter_key();
    }

    // 回车是提交动作。之后的回读只用于日志：如果回读失败还返回 Err，
    // 调用方会保留 WAL 并重试，结果就是同一条消息被再次粘贴/回车（真机已复现）。
    // 因此只要 Enter 已发出，就按“已提交”处理，宁可日志标为未确认，也不重复投递。
    let mut cleared = false;
    if had_value.is_some() {
        for _ in 0..30 {
            match uia::input_value(hwnd) {
                Some(v) if v.contains(&marker) => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                _ => { cleared = true; break; }
            }
        }
    } else if direct_text {
        for _ in 0..20 {
            match uia::composer_text(hwnd) {
                Some(t) if t.contains(&marker) => {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                _ => { cleared = true; break; }
            }
        }
    } else {
        for _ in 0..20 {
            if read_window_text(hwnd, true).map(|t| !t.contains(&marker)).unwrap_or(false) {
                cleared = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }
    if !cleared {
        eprintln!("[winmsg] 已按回车，但回读未确认输入框清空；为避免重复投递，按已提交处理");
    }
    Ok(true)
}

#[cfg(not(windows))]
pub fn send_text_click_paste_checked(
    _hwnd: usize, _text: &str, _press_enter: bool, _click_x_ratio: f64, _click_y_ratio: f64,
) -> Result<bool, String> {
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
        let h = hwnd as sys::HWND;
        if sys::GetForegroundWindow() != h {
            return Err("目标窗口不是前台窗口，已中止读取".into());
        }
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
