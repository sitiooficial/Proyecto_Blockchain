#!/usr/bin/env bash
set -e

echo "🚀 Iniciando build automatizado para FRONTEND + BACKEND"

# ===== BACKEND =====
if [ -d "backend" ]; then
  echo "📦 Instalando dependencias del backend..."
  cd backend
  npm install

  echo "✔️ Dependencias backend instaladas"
  cd ..
else
  echo "⚠️ No se encontró carpeta /backend"
fi



echo "🎉 Build completado correctamente"
