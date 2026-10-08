#[cfg(windows)]
mod build_support;

fn main() {
    #[cfg(windows)]
    {
        let out_dir = build_support::prepare_tauri_out_dir()
            .expect("Tauri metadata requires a volume supporting native final-path queries");
        build_support::repair_ramdisk_permissions(&out_dir)
            .expect("failed to recover generated Tauri permissions on the build volume");
    }
    tauri_build::build()
}
