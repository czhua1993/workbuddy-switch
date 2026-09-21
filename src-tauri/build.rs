fn main() {
    // 图标资源变更必须触发重新编译，否则 Windows 可执行文件不会重新嵌入图标
    // （tauri-build 默认不监听 icons/ 目录，改图标后不重建会一直沿用旧图标）。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon-windows.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    // 窗口图标的多档 raw RGBA：`include_bytes!` 不会被 cargo 视为依赖，改素材后
    // 不声明就不会重新编译（与 build.rs 顶部注释同一个坑）。
    println!("cargo:rerun-if-changed=icons/window-icon-32.rgba");
    println!("cargo:rerun-if-changed=icons/window-icon-48.rgba");
    println!("cargo:rerun-if-changed=icons/window-icon-64.rgba");
    println!("cargo:rerun-if-changed=icons/window-icon-128.rgba");
    tauri_build::build()
}
