//! Binário do backend LibrasLive (axum + tokio).
//!
//! Uso:
//!   LIBRASLIVE_DEMO_STT=1 cargo run -p libraslive-server
//!   LIBRASLIVE_WHISPER_MODEL=models/ggml-small.bin cargo run -p libraslive-server

use std::net::SocketAddr;

use libraslive_server::{build_state, create_router, start_background_tasks};
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    let state = build_state();
    start_background_tasks(state.clone()).await;
    let porta: u16 = std::env::var("LIBRASLIVE_PORT")
        .ok()
        .and_then(|valor| valor.parse().ok())
        .unwrap_or(8000);
    let endereco = SocketAddr::from(([127, 0, 0, 1], porta));
    let router = create_router(state);
    info!(%endereco, "backend LibrasLive ouvindo");
    let listener = tokio::net::TcpListener::bind(endereco)
        .await
        .expect("falha ao abrir porta do backend");
    axum::serve(listener, router).await.expect("falha no servidor axum");
}
