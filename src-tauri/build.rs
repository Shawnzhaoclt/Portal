fn main() {
    for icon in [
        "icons/16x16.png",
        "icons/20x20.png",
        "icons/24x24.png",
        "icons/32x32.png",
        "icons/40x40.png",
        "icons/48x48.png",
        "icons/64x64.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.ico",
        "icons/icon.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}
