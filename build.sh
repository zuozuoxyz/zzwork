# zzwork 构建脚本（Git Bash / Linux）
# 从官方 VS Code zip 组装 zzwork 发行版
# 用法: ./build.sh [VS_Code_win32-x64.zip 或下载目录]
#   不带参数时尝试从 update.code.visualstudio.com 下载（需要网络）

set -e
cd "$(dirname "$0")"
VS_VERSION="1.142.0"
EXT_DIR="6d62b1d5da/resources/app/extensions/zzwork"

ZIP="${1:-vscode-$VS_VERSION.zip}"
if [ ! -f "$ZIP" ]; then
  echo ">> 下载 VS Code $VS_VERSION ..."
  curl -L -o "$ZIP" "https://update.code.visualstudio.com/$VS_VERSION/win32-x64/stable" || {
    echo "!! 下载失败。请手动下载 win32-x64 zip 后: ./build.sh <zip路径>"
    exit 1
  }
fi

echo ">> 解压 $ZIP ..."
rm -rf build && mkdir build
unzip -q "$ZIP" -d build

# 官方 zip 为双层：顶层 Code.exe + <commit>/ 子目录，真实应用在 <commit>/
DIST=""
for d in build/*/; do
  if [ -d "$d/resources/app/out" ]; then DIST="${d%/}"; break; fi
done
[ -z "$DIST" ] && { echo "!! 未找到发行版结构"; exit 1; }
echo ">> 发行版目录: $DIST"

echo ">> 品牌化 product.json ..."
node patches/brand.js "$DIST/resources/app/product.json"

echo ">> 打 workbench 补丁（隐藏登录/AI/更新 + 活动栏重排）..."
node patches/patch-workbench.js "$DIST/resources/app" patches

echo ">> 移除登录/AI 相关内置扩展 ..."
mkdir -p "$DIST/removed-extensions"
for ext in copilot github github-authentication microsoft-authentication "TypeScriptTeam.jsts-chat-features"; do
  if [ -d "$DIST/resources/app/extensions/$ext" ]; then
    mv "$DIST/resources/app/extensions/$ext" "$DIST/removed-extensions/"
  fi
done

echo ">> 安装 zzwork 扩展依赖（better-sqlite3 electron-v148 预编译）..."
if [ ! -d "$EXT_DIR/node_modules/better-sqlite3" ]; then
  (cd "$EXT_DIR" && npm install --ignore-scripts && \
    (cd node_modules/better-sqlite3 && npx prebuild-install r -t electron-v148.0.0 || \
     echo "!! 预编译下载失败，可手动: cd node_modules/better-sqlite3 && prebuild-install r -t electron-v148.0.0"))
fi

echo ">> 完成: $DIST/Code.exe 即 zzwork"
