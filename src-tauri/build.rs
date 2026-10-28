fn main() {
    // Tauri embeds the development icon at compile time, so changes to the
    // source assets must also trigger recompilation of the application.
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    tauri_build::build()
}
