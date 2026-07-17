fn main() {
    // Embed the Windows application manifest so the OS recognises:
    //   - Windows 10 / 11 as supported (supportedOS GUID)
    //   - Per-monitor v2 DPI awareness
    //   - Long-path support
    // The manifest file lives at src/app.manifest and is only linked in on
    // Windows targets; on Linux/macOS this is a no-op.
    #[cfg(target_os = "windows")]
    {
        let mut res = winres::WindowsResource::new();
        res.set_manifest_file("src/app.manifest");
        res.compile().expect("failed to compile Windows resources");
    }

    tauri_build::build()
}
