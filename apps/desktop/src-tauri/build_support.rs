//! Build-only workaround for ImDisk volumes whose GetFinalPathNameByHandle(DOS)
//! fails. Tauri 2.12 drops generated core permissions when canonicalize fails.
//! Recover only those generated file lists, into our own OUT_DIR; never change
//! capabilities, permission contents, dependency sources, or global Cargo config.
use std::{fs, io, hash::{Hash, Hasher}, path::{Path, PathBuf}};

/// Keep Cargo's target-dir intact. Only Tauri's generated ACL/resources/assets
/// need a normal filesystem; large compiler intermediates and the EXE stay on
/// the configured volume. OUT_DIR is private to this app's build script/rustc.
#[allow(dead_code)]
pub fn prepare_tauri_out_dir() -> io::Result<PathBuf> {
    let original = PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo provides OUT_DIR"));
    match original.canonicalize() {
        Ok(_) => return Ok(original),
        Err(error) if error.raw_os_error() == Some(1) => {},
        Err(error) => return Err(error),
    }
    println!("cargo:rerun-if-env-changed=ONEWARDEN_TAURI_METADATA_DIR");
    let root = std::env::var_os("ONEWARDEN_TAURI_METADATA_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|path| PathBuf::from(path).join("1Warden/build-metadata")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Set ONEWARDEN_TAURI_METADATA_DIR to a normal-disk directory"))?;
    // Isolate projects, profiles, targets and Cargo build fingerprints.
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    original.hash(&mut hash);
    std::env::var_os("CARGO_MANIFEST_DIR").hash(&mut hash);
    let staged = root.join(format!("{:016x}", hash.finish())).join("build/onewarden/out");
    fs::create_dir_all(&staged)?;
    staged.canonicalize()?;
    std::env::set_var("OUT_DIR", &staged);
    println!("cargo:rustc-env=OUT_DIR={}", staged.display());
    println!("cargo:warning=ImDisk compatibility: Tauri metadata at {}; Cargo target-dir is unchanged", staged.display());
    Ok(staged)
}

fn json_error(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn collect_toml(directory: &Path, recursive: bool, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() && recursive {
            collect_toml(&entry.path(), true, files)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "toml") {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn recover_core_permissions(
    manifest: &Path,
    canonicalize: impl Fn(&Path) -> io::Result<PathBuf>,
) -> io::Result<Option<Vec<PathBuf>>> {
    let name = manifest.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    let Some(plugin) = name.strip_prefix("tauri-core").and_then(|name| name.strip_suffix("-permission-files")) else {
        return Ok(None);
    };
    if !["", "-app", "-event", "-image", "-menu", "-path", "-resources", "-tray", "-webview", "-window"].contains(&plugin) {
        return Ok(None);
    }
    let existing: Vec<PathBuf> = serde_json::from_slice(&fs::read(manifest)?).map_err(json_error)?;
    if !existing.is_empty() { return Ok(None); }
    let Some(parent) = manifest.parent() else { return Ok(None); };
    let mut directory = parent.join("permissions");
    if !plugin.is_empty() { directory.push(&plugin[1..]); }
    let mut files = Vec::new();
    collect_toml(&directory, !plugin.is_empty(), &mut files)?;
    files.sort();
    // An empty list on a normal filesystem should remain an upstream error.
    // This fallback is exclusively for existing, readable generated TOML files
    // whose native final-path query fails (not ordinary missing-file errors).
    if files.is_empty() || files.iter().any(|file| !matches!(canonicalize(file), Err(error) if error.raw_os_error() == Some(1))) { return Ok(None); }
    for file in &files { fs::read(file)?; }
    Ok(Some(files))
}

#[allow(dead_code)] // Also compiled into the test harness below.
pub fn repair_ramdisk_permissions(out_dir: &Path) -> io::Result<()> {
    let mut repaired_count = 0;
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if !name.starts_with("DEP_TAURI_") || !name.ends_with("__CORE_PLUGIN___PERMISSION_FILES_PATH") { continue; }
        let manifest = PathBuf::from(value);
        let Some(files) = recover_core_permissions(&manifest, |path| path.canonicalize())? else { continue; };
        let repaired = out_dir.join("ramdisk-permissions").join(manifest.file_name().unwrap());
        fs::create_dir_all(repaired.parent().unwrap())?;
        fs::write(&repaired, serde_json::to_vec(&files).map_err(json_error)?)?;
        for file in files { println!("cargo:rerun-if-changed={}", file.display()); }
        // Build scripts are single-threaded here; tauri_build reads these next.
        std::env::set_var(key, repaired);
        repaired_count += 1;
    }
    if repaired_count > 0 { println!("cargo:warning=Recovered {repaired_count} generated Tauri core permission indexes without changing capabilities"); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unsupported(_: &Path) -> io::Result<PathBuf> {
        Err(io::Error::from_raw_os_error(1))
    }
    #[test]
    fn recovers_only_generated_core_files_without_changing_originals() {
        let fixture = std::env::temp_dir().join(format!("1warden-permissions-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let commands = fixture.join("permissions/window/autogenerated/commands");
        fs::create_dir_all(&commands).unwrap();
        let command = commands.join("start_dragging.toml");
        fs::write(&command, "[[permission]]\nidentifier = 'allow-start-dragging'\n").unwrap();
        fs::write(commands.join("reference.md"), "not a permission").unwrap();
        let core = fixture.join("permissions/default.toml");
        fs::write(&core, "[default]\npermissions = ['core:window:default']\n").unwrap();
        let window_manifest = fixture.join("tauri-core-window-permission-files");
        let core_manifest = fixture.join("tauri-core-permission-files");
        fs::write(&window_manifest, "[]").unwrap();
        fs::write(&core_manifest, "[]").unwrap();
        assert_eq!(recover_core_permissions(&window_manifest, unsupported).unwrap(), Some(vec![command.clone()]));
        assert_eq!(recover_core_permissions(&core_manifest, unsupported).unwrap(), Some(vec![core]));
        assert_eq!(fs::read_to_string(&window_manifest).unwrap(), "[]");
        assert_eq!(recover_core_permissions(&window_manifest, |path| Ok(path.to_owned())).unwrap(), None);
        assert_eq!(recover_core_permissions(&window_manifest, |_| Err(io::Error::from_raw_os_error(5))).unwrap(), None);
        fs::write(&window_manifest, serde_json::to_vec(&vec![command]).unwrap()).unwrap();
        assert_eq!(recover_core_permissions(&window_manifest, unsupported).unwrap(), None);
        assert_eq!(recover_core_permissions(&fixture.join("some-plugin-permission-files"), unsupported).unwrap(), None);
        // Unique, self-created fixture only. No shared target cache is removed.
        fs::remove_dir_all(fixture).unwrap();
    }
}
