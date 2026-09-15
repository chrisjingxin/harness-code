#!/usr/bin/env bash
# Harness Code Unix 安装器：检测并补齐 Bun / uv / Python，再安装界面包与内核包。
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [--version X.Y.Z] [--no-modify-path] [--help]

Install Harness Code for macOS or Linux.

  --version X.Y.Z     Pin @za38/cli and za38-agent (default: latest)
  --no-modify-path    Do not edit shell rc files
  --help              Show this help

Fill DEFAULT_* at the top before hosting so users need no env vars.

Environment (optional overrides):
  HARNESS_INSTALL_VERSION     Same as --version
  HARNESS_NO_MODIFY_PATH      Set to 1 for --no-modify-path
  HARNESS_NPM_REGISTRY        bun registry for @za38/cli
  UV_INDEX_URL                uv index for za38-agent
  HARNESS_BUN_INSTALL_URL     Override Bun installer
  HARNESS_UV_INSTALL_URL      Override uv installer
  HARNESS_INSTALL_BASE_URL    Host for this script and example config
  HARNESS_EXAMPLE_CONFIG      Local example config.toml to copy
EOF
}

MIN_BUN="1.2.19"
CLI_PACKAGE="@za38/cli"
AGENT_PACKAGE="za38-agent"

# 托管到企业域名之前填写这三行。仓库里不要写死某个域名。
DEFAULT_INSTALL_BASE_URL=""
DEFAULT_NPM_REGISTRY=""
DEFAULT_PYPI_INDEX=""

VERSION="${HARNESS_INSTALL_VERSION:-latest}"
NO_MODIFY_PATH="${HARNESS_NO_MODIFY_PATH:-0}"
HARNESS_INSTALL_BASE_URL="${HARNESS_INSTALL_BASE_URL:-$DEFAULT_INSTALL_BASE_URL}"
HARNESS_NPM_REGISTRY="${HARNESS_NPM_REGISTRY:-$DEFAULT_NPM_REGISTRY}"
UV_INDEX_URL="${UV_INDEX_URL:-$DEFAULT_PYPI_INDEX}"
BUN_INSTALL_URL="${HARNESS_BUN_INSTALL_URL:-https://bun.sh/install}"
UV_INSTALL_URL="${HARNESS_UV_INSTALL_URL:-https://astral.sh/uv/install.sh}"

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --version)
      if [ $# -lt 2 ] || [[ "$2" == -* ]]; then
        echo "error: --version requires X.Y.Z" >&2
        usage >&2
        exit 2
      fi
      VERSION="$2"
      shift 2
      ;;
    --no-modify-path)
      NO_MODIFY_PATH=1
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

os="${HARNESS_INSTALL_OS:-$(uname -s)}"
arch="${HARNESS_INSTALL_ARCH:-$(uname -m)}"
libc="${HARNESS_INSTALL_LIBC:-}"

normalize_arch() {
  case "$1" in
    x86_64|amd64) echo x64 ;;
    arm64|aarch64) echo arm64 ;;
    *) echo "$1" ;;
  esac
}

arch="$(normalize_arch "$arch")"

if [ -z "$libc" ]; then
  if [ -f /etc/alpine-release ]; then
    libc=musl
  elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    libc=musl
  else
    libc=glibc
  fi
fi

case "$os" in
  Darwin|darwin|Linux|linux) ;;
  *)
    echo "error: unsupported OS: $os (use install.ps1 on Windows)" >&2
    exit 1
    ;;
esac

if [ "$libc" = "musl" ]; then
  echo "error: Linux musl is not supported in this release." >&2
  exit 1
fi

case "$arch" in
  x64|arm64) ;;
  *)
    echo "error: unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

version_ge() {
  local current="$1"
  local minimum="$2"
  [ "$(printf '%s\n%s\n' "$minimum" "$current" | sort -V | head -n1)" = "$minimum" ]
}

have_bun() {
  command -v bun >/dev/null 2>&1 || return 1
  local raw
  raw="$(bun --version 2>/dev/null || true)"
  raw="${raw%%-*}"
  [ -n "$raw" ] && version_ge "$raw" "$MIN_BUN"
}

have_uv() {
  command -v uv >/dev/null 2>&1
}

have_python() {
  command -v uv >/dev/null 2>&1 || return 1
  uv python find 3.12 >/dev/null 2>&1 || uv python find 3.11 >/dev/null 2>&1
}

download_install() {
  local url="$1"
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required to download $url" >&2
    exit 1
  fi
  curl -fsSL "$url"
}

if ! have_bun; then
  echo "Installing Bun ${MIN_BUN}..."
  download_install "$BUN_INSTALL_URL" | BUN_VERSION="$MIN_BUN" bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! have_bun; then
    echo "error: Bun install finished but bun >= ${MIN_BUN} is not on PATH" >&2
    exit 1
  fi
fi

if ! have_uv; then
  echo "Installing uv..."
  download_install "$UV_INSTALL_URL" | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! have_uv; then
    echo "error: uv install finished but uv is not on PATH" >&2
    exit 1
  fi
fi

if ! have_python; then
  echo "Installing Python 3.12 with uv..."
  uv python install 3.12
fi

cli_ref="$CLI_PACKAGE"
agent_ref="$AGENT_PACKAGE"
if [ "$VERSION" != "latest" ]; then
  cli_ref="${CLI_PACKAGE}@${VERSION}"
  agent_ref="${AGENT_PACKAGE}==${VERSION}"
fi

if [ -z "$HARNESS_NPM_REGISTRY" ] || [ -z "$UV_INDEX_URL" ]; then
  echo "error: set DEFAULT_NPM_REGISTRY and DEFAULT_PYPI_INDEX at the top of this script before hosting, or export HARNESS_NPM_REGISTRY and UV_INDEX_URL." >&2
  exit 1
fi

echo "Installing ${cli_ref} from ${HARNESS_NPM_REGISTRY}..."
bun install -g "$cli_ref" --registry "$HARNESS_NPM_REGISTRY"

echo "Installing ${agent_ref} from ${UV_INDEX_URL}..."
uv tool install "$agent_ref" --index "$UV_INDEX_URL"

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"

if ! command -v harness >/dev/null 2>&1 || ! harness --version >/dev/null 2>&1; then
  echo "error: harness --version failed after install" >&2
  exit 1
fi

path_block_begin="# >>> harness installer >>>"
path_block_end="# <<< harness installer <<<"
path_export='export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"'

write_path_block() {
  local file="$1"
  mkdir -p "$(dirname "$file")"
  if [ -f "$file" ] && grep -q "$path_block_begin" "$file"; then
    local tmp="$file.tmp.$$"
    awk -v begin="$path_block_begin" -v end="$path_block_end" -v block="$path_block_begin
$path_export
$path_block_end" '
      $0 == begin { skip=1; print block; next }
      $0 == end { skip=0; next }
      !skip { print }
    ' "$file" > "$tmp" && mv "$tmp" "$file"
    return
  fi
  {
    echo ""
    echo "$path_block_begin"
    echo "$path_export"
    echo "$path_block_end"
  } >> "$file"
}

if [ "$NO_MODIFY_PATH" != "1" ]; then
  user_shell="$(basename "${SHELL:-}")"
  case "$user_shell" in
    bash) write_path_block "$HOME/.bashrc" ;;
    zsh) write_path_block "$HOME/.zshrc" ;;
    fish)
      mkdir -p "$HOME/.config/fish"
      if ! grep -qs "harness installer" "$HOME/.config/fish/config.fish" 2>/dev/null; then
        printf '\n# >>> harness installer >>>\nfish_add_path $HOME/.bun/bin\nfish_add_path $HOME/.local/bin\n# <<< harness installer <<<\n' >> "$HOME/.config/fish/config.fish"
      fi
      ;;
    *)
      write_path_block "$HOME/.profile"
      ;;
  esac
  if [ -d "$HOME/.local/bin" ]; then
    ln -sf "$BUN_INSTALL/bin/harness" "$HOME/.local/bin/harness" 2>/dev/null || true
  fi
fi

example_src="${HARNESS_EXAMPLE_CONFIG:-}"
if [ -z "$example_src" ]; then
  script_path="${BASH_SOURCE[0]:-}"
  if [ -n "$script_path" ] && [ -f "$script_path" ]; then
    repo_example="$(cd "$(dirname "$script_path")/../.." && pwd)/docs/user/examples/config.toml"
    if [ -f "$repo_example" ]; then
      example_src="$repo_example"
    fi
  fi
fi
if [ -z "$example_src" ]; then
  tmp_example="$(mktemp)"
  if curl -fsSL "${HARNESS_INSTALL_BASE_URL%/}/examples/config.toml" -o "$tmp_example"; then
    example_src="$tmp_example"
  else
    rm -f "$tmp_example"
  fi
fi

config_path="$HOME/.harness/config.toml"
if [ ! -f "$config_path" ] && [ -n "${example_src:-}" ] && [ -f "$example_src" ]; then
  mkdir -p "$HOME/.harness"
  cp "$example_src" "$config_path"
  chmod 600 "$config_path" 2>/dev/null || true
  echo "Wrote example config to $config_path. Set HARNESS_API_KEY or edit the file; do not commit secrets."
elif [ -f "$config_path" ]; then
  echo "Keeping existing $config_path"
fi

echo "Harness ${VERSION} installed. Run: harness"
echo "If the command is not found, open a new terminal or: export PATH=\"\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH\""
