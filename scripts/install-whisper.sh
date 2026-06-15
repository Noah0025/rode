#!/bin/sh
# 装 whisper.cpp（STT 默认实现）+ 下载中文模型。幂等。
set -e
MODEL_DIR="${1:-models}"; MODEL="$MODEL_DIR/ggml-medium.bin"
if command -v whisper-server >/dev/null 2>&1; then echo "whisper-server 已装"; else
  if command -v brew >/dev/null 2>&1; then brew install whisper-cpp
  else echo "请自行编译 whisper.cpp 并确保 whisper-server 在 PATH (Linux: github.com/ggerganov/whisper.cpp)"; exit 1; fi
fi
mkdir -p "$MODEL_DIR"
if [ -f "$MODEL" ]; then echo "模型已存在: $MODEL"; else
  echo "下载 ggml-medium..."; curl -L -o "$MODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin
fi
echo "✓ whisper 就绪。常驻起服: whisper-server -m $MODEL -l zh --host 127.0.0.1 --port 18791"
