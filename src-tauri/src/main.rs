#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct BackendState(Mutex<Option<Child>>);

fn python_command() -> &'static str {
    if cfg!(target_os = "windows") {
        "python"
    } else {
        "python3"
    }
}

fn bundled_backend_executable(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let executable_name = if cfg!(target_os = "windows") {
        "genome-explorer-backend.exe"
    } else {
        "genome-explorer-backend"
    };
    let candidate = resource_dir.join(executable_name);
    if candidate.exists() {
        return Ok(Some(candidate));
    }
    Ok(None)
}

fn backend_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let mut current = std::env::current_dir().map_err(|error| error.to_string())?;
        current.push("..");
        current.push("server.py");
        return Ok(current);
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    Ok(resource_dir.join("server.py"))
}

fn spawn_backend(app: &tauri::AppHandle) -> Result<Child, String> {
    if let Some(executable) = bundled_backend_executable(app)? {
        let executable_dir = executable
            .parent()
            .ok_or_else(|| "Bundled backend executable directory could not be determined".to_string())?;
        let mut command = Command::new(executable);
        command
            .current_dir(executable_dir)
            .env("HOST", "127.0.0.1")
            .env("PORT", "8765")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        return command
            .spawn()
            .map_err(|error| format!("Failed to launch bundled backend service: {error}"));
    }

    let script = backend_script(app)?;
    let script_dir = script
        .parent()
        .ok_or_else(|| "Backend script directory could not be determined".to_string())?;

    let mut command = Command::new(python_command());
    command
        .arg(script)
        .current_dir(script_dir)
        .env("HOST", "127.0.0.1")
        .env("PORT", "8765")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command
        .spawn()
        .map_err(|error| format!("Failed to launch backend service: {error}"))
}

fn main() {
    tauri::Builder::default()
        .manage(BackendState(Mutex::new(None)))
        .setup(|app| {
            let child = spawn_backend(app.handle())?;
            {
                let state = app.state::<BackendState>();
                let mut slot = state.0.lock().map_err(|_| "Backend state lock poisoned")?;
                *slot = Some(child);
            }

            let url = "http://127.0.0.1:8765"
                .parse()
                .map_err(|error| format!("Invalid webview URL: {error}"))?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Locus Zoom")
                .inner_size(1600.0, 1024.0)
                .build()
                .map_err(|error| error.to_string())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let state = app.state::<BackendState>();
                if let Ok(mut slot) = state.0.lock() {
                    if let Some(mut child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Locus Zoom desktop");
}
