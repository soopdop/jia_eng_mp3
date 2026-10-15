#!/bin/sh
# 시놀로지 NAS DS118 백그라운드 자동 실행 스크립트
cd "$(dirname "$0")"
pkill -f "node server.js" 2>/dev/null
PORT=3000 nohup node server.js > server.log 2>&1 &
echo "🎧 지아 영어 듣기 서버가 백그라운드에서 실행되었습니다! (포트 3000)"

