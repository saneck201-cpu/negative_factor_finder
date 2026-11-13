#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Не найден Node.js. Установите его с https://nodejs.org"; exit 1; }
(sleep 1; open http://localhost:8787 2>/dev/null || xdg-open http://localhost:8787 2>/dev/null) &
node server.js
