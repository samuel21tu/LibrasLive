#!/usr/bin/env bash
# LibrasLive — verificação determinística dos contratos Rust (spec seção 6).
#
# Uso:
#   bash scripts/verify-rust-contracts.sh
#   bash scripts/verify-rust-contracts.sh -- --nocapture
#
# Exit code: 0 = todos os crates passaram, 1 = falha (ou cargo/workspace ausente).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v cargo >/dev/null 2>&1; then
  echo "ERRO: cargo não encontrado no PATH" >&2
  exit 1
fi

if [[ ! -f Cargo.toml ]]; then
  echo "ERRO: Cargo.toml do workspace não encontrado em $PROJECT_ROOT" >&2
  exit 1
fi

echo "==> cargo test -p libraslive-nlp -p libraslive-server -p libraslive-audio -p libraslive-stt"
cargo test -p libraslive-nlp -p libraslive-server -p libraslive-audio -p libraslive-stt "$@"
echo "RESULTADO: contratos Rust OK"
