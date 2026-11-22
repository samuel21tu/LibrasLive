use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
};

const DEFAULT_WIDTH: u32 = 440;
const DEFAULT_HEIGHT: u32 = 580;
const MIN_WIDTH: u32 = 280;
const MIN_HEIGHT: u32 = 320;
const MARGIN: i32 = 16;
const CONFIG_FILE: &str = "panel-config.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Corner {
    SuperiorDireito,
    SuperiorEsquerdo,
    InferiorDireito,
    InferiorEsquerdo,
}

impl Corner {
    fn parse(value: &str) -> Self {
        match value {
            "top-left" | "superior-esquerdo" => Corner::SuperiorEsquerdo,
            "bottom-left" | "inferior-esquerdo" => Corner::InferiorEsquerdo,
            "bottom-right" | "inferior-direito" => Corner::InferiorDireito,
            _ => Corner::SuperiorDireito,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelConfig {
    tamanho: f64,
    opacidade: f64,
    canto: Corner,
    always_on_top: bool,
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self {
            tamanho: 1.0,
            opacidade: 0.96,
            canto: Corner::SuperiorDireito,
            always_on_top: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlaySize {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayState {
    corner: Corner,
    size: OverlaySize,
    always_on_top: bool,
    ignore_mouse: bool,
    opacity: f64,
    platform: &'static str,
    backend_running: bool,
}

struct RuntimeState {
    config: PanelConfig,
    ignore_mouse: bool,
    backend: Option<Child>,
    server_started: bool,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("dados do app indisponiveis: {error}"))?;
    Ok(dir.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> PanelConfig {
    let path = match config_path(app) {
        Ok(path) => path,
        Err(_) => return PanelConfig::default(),
    };
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return PanelConfig::default(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &PanelConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn apply_opacity(window: &WebviewWindow, opacity: f64) {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let _ = window.set_opacity(opacity.clamp(0.1, 1.0));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = window;
        let _ = opacity;
    }
}

fn apply_corner(window: &WebviewWindow, corner: Corner) {
    let monitor = match window.current_monitor().ok().flatten() {
        Some(monitor) => monitor,
        None => return,
    };
    let area = monitor.work_area();
    let size = window
        .outer_size()
        .unwrap_or_else(|_| PhysicalSize::new(DEFAULT_WIDTH, DEFAULT_HEIGHT));

    let width = size.width as i32;
    let height = size.height as i32;
    let (x, y) = match corner {
        Corner::SuperiorEsquerdo => (area.position.x + MARGIN, area.position.y + MARGIN),
        Corner::SuperiorDireito => (
            area.position.x + area.size.width as i32 - width - MARGIN,
            area.position.y + MARGIN,
        ),
        Corner::InferiorEsquerdo => (
            area.position.x + MARGIN,
            area.position.y + area.size.height as i32 - height - MARGIN,
        ),
        Corner::InferiorDireito => (
            area.position.x + area.size.width as i32 - width - MARGIN,
            area.position.y + area.size.height as i32 - height - MARGIN,
        ),
    };

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn build_state(window: &WebviewWindow, state: &RuntimeState) -> OverlayState {
    let size = window
        .outer_size()
        .unwrap_or_else(|_| PhysicalSize::new(DEFAULT_WIDTH, DEFAULT_HEIGHT));
    OverlayState {
        corner: state.config.canto,
        size: OverlaySize {
            width: size.width,
            height: size.height,
        },
        always_on_top: state.config.always_on_top,
        ignore_mouse: state.ignore_mouse,
        opacity: state.config.opacidade,
        platform: std::env::consts::OS,
        backend_running: state.server_started || state.backend.is_some(),
    }
}

fn boot_backend(state: &mut RuntimeState) -> bool {
    if state.server_started || state.backend.is_some() {
        return true;
    }

    if let Ok(binary) = std::env::var("LIBRASLIVE_SERVER_BIN") {
        return match Command::new(binary)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                state.backend = Some(child);
                state.server_started = true;
                true
            }
            Err(error) => {
                eprintln!("[LibrasLive] falha ao iniciar o servidor externo: {error}");
                false
            }
        };
    }

    tauri::async_runtime::spawn(async {
        let app_state = libraslive_server::build_state();
        let router = libraslive_server::create_router(app_state);
        match tokio::net::TcpListener::bind("127.0.0.1:8000").await {
            Ok(listener) => {
                eprintln!("[LibrasLive] axum ouvindo em ws://127.0.0.1:8000/stream");
                if let Err(error) = axum::serve(listener, router).await {
                    eprintln!("[LibrasLive] erro no servidor axum: {error}");
                }
            }
            Err(error) => {
                eprintln!("[LibrasLive] falha ao abrir a porta 8000: {error}");
            }
        }
    });
    state.server_started = true;
    true
}

#[tauri::command]
fn get_state(
    window: WebviewWindow,
    state: State<'_, Mutex<RuntimeState>>,
) -> Result<OverlayState, String> {
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(build_state(&window, &guard))
}

#[tauri::command]
fn move_corner(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Mutex<RuntimeState>>,
    corner: String,
) -> Result<OverlayState, String> {
    let corner = Corner::parse(&corner);
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.config.canto = corner;
        save_config(&app, &guard.config)?;
    }
    apply_corner(&window, corner);
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(build_state(&window, &guard))
}

#[tauri::command]
fn cycle_corner(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Mutex<RuntimeState>>,
) -> Result<OverlayState, String> {
    let next = {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.config.canto = match guard.config.canto {
            Corner::SuperiorDireito => Corner::InferiorDireito,
            Corner::InferiorDireito => Corner::InferiorEsquerdo,
            Corner::InferiorEsquerdo => Corner::SuperiorEsquerdo,
            Corner::SuperiorEsquerdo => Corner::SuperiorDireito,
        };
        save_config(&app, &guard.config)?;
        guard.config.canto
    };
    apply_corner(&window, next);
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(build_state(&window, &guard))
}

#[tauri::command]
fn resize_window(
    window: WebviewWindow,
    state: State<'_, Mutex<RuntimeState>>,
    width: u32,
    height: u32,
) -> Result<OverlayState, String> {
    let width = width.clamp(MIN_WIDTH, 3840);
    let height = height.clamp(MIN_HEIGHT, 2160);
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    let corner = state
        .lock()
        .map_err(|error| error.to_string())?
        .config
        .canto;
    apply_corner(&window, corner);
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(build_state(&window, &guard))
}

#[tauri::command]
fn drag_window(window: WebviewWindow, delta_x: i32, delta_y: i32) -> Result<(), String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            position.x + delta_x,
            position.y + delta_y,
        ))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_opacity(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Mutex<RuntimeState>>,
    opacity: f64,
) -> Result<OverlayState, String> {
    let opacity = opacity.clamp(0.1, 1.0);
    apply_opacity(&window, opacity);
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.config.opacidade = opacity;
        save_config(&app, &guard.config)?;
    }
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(build_state(&window, &guard))
}

#[tauri::command]
fn set_ignore_mouse(
    window: WebviewWindow,
    state: State<'_, Mutex<RuntimeState>>,
    ignore: bool,
) -> Result<OverlayState, String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| error.to_string())?;
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.ignore_mouse = ignore;
    }
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(build_state(&window, &guard))
}

#[tauri::command]
fn set_always_on_top(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Mutex<RuntimeState>>,
    value: bool,
) -> Result<OverlayState, String> {
    window
        .set_always_on_top(value)
        .map_err(|error| error.to_string())?;
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.config.always_on_top = value;
        save_config(&app, &guard.config)?;
    }
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(build_state(&window, &guard))
}

#[tauri::command]
fn get_config(state: State<'_, Mutex<RuntimeState>>) -> Result<PanelConfig, String> {
    Ok(state
        .lock()
        .map_err(|error| error.to_string())?
        .config
        .clone())
}

#[tauri::command]
fn set_config(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Mutex<RuntimeState>>,
    config: PanelConfig,
) -> Result<(), String> {
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.config = config.clone();
        save_config(&app, &config)?;
    }
    window
        .set_always_on_top(config.always_on_top)
        .map_err(|error| error.to_string())?;
    apply_opacity(&window, config.opacidade);
    apply_corner(&window, config.canto);
    Ok(())
}

#[tauri::command]
fn minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_window(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn start_backend(state: State<'_, Mutex<RuntimeState>>) -> Result<bool, String> {
    let mut guard = state.lock().map_err(|error| error.to_string())?;
    Ok(boot_backend(&mut guard))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(RuntimeState {
            config: PanelConfig::default(),
            ignore_mouse: false,
            backend: None,
            server_started: false,
        }))
        .setup(|app| {
            let config = load_config(app.handle());
            {
                let state = app.state::<Mutex<RuntimeState>>();
                let mut guard = state.lock().map_err(|error| error.to_string())?;
                guard.config = config.clone();
                boot_backend(&mut guard);
            }

            if let Some(window) = app.get_webview_window("main") {
                window
                    .set_always_on_top(config.always_on_top)
                    .map_err(|error| error.to_string())?;
                apply_opacity(&window, config.opacidade);
                apply_corner(&window, config.canto);
            }

            let show = MenuItemBuilder::with_id("show", "Mostrar")
                .build(app)
                .map_err(|error| error.to_string())?;
            let quit = MenuItemBuilder::with_id("quit", "Sair")
                .build(app)
                .map_err(|error| error.to_string())?;
            let menu = MenuBuilder::new(app)
                .items(&[&show, &quit])
                .build()
                .map_err(|error| error.to_string())?;

            let _tray = TrayIconBuilder::with_id("tray")
                .icon(
                    app.default_window_icon()
                        .ok_or_else(|| "icone padrao ausente".to_string())?
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)
                .map_err(|error| error.to_string())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            move_corner,
            cycle_corner,
            resize_window,
            drag_window,
            set_opacity,
            set_ignore_mouse,
            set_always_on_top,
            get_config,
            set_config,
            minimize,
            close_window,
            start_backend,
        ])
        .build(tauri::generate_context!())
        .expect("falha ao construir o LibrasLive")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<Mutex<RuntimeState>>() {
                    if let Ok(mut guard) = state.lock() {
                        if let Some(child) = guard.backend.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
