#!/usr/bin/env bash

set -euo pipefail

FFMPEG="${FFMPEG_PATH:-ffmpeg}"

if [ "$#" -lt 1 ]; then
  echo "Usage : $0 video.mov [video2.mkv ...]" >&2
  exit 1
fi

if ! command -v "$FFMPEG" >/dev/null 2>&1; then
  echo "ffmpeg introuvable (essayé : \"$FFMPEG\"). Installe-le (ex : sudo dnf install ffmpeg) ou définis FFMPEG_PATH." >&2
  exit 1
fi

for input in "$@"; do
  if [ ! -f "$input" ]; then
    echo "Fichier introuvable : $input" >&2
    exit 1
  fi

  dir="$(dirname "$input")"
  base="$(basename "$input")"
  output="$dir/${base%.*}-tagplay.mp4"

  echo ">> $input -> $output"
  "$FFMPEG" -y \
    -i "$input" \
    -c:v libx264 \
    -pix_fmt yuv420p \
    -crf 28 \
    -preset slow \
    -c:a aac \
    -b:a 96k \
    -movflags +faststart \
    "$output"
done

echo "Terminé. Upload ensuite le(s) fichier(s) *-tagplay.mp4 (voir README)."
