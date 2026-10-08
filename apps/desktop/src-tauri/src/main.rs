// 发布版不弹控制台窗口（Windows 上尤其明显）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    onewarden_lib::run();
}
