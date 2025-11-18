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

# ===== FRONTEND =====
if [ -d "frontend" ]; then
  echo "🌐 Construyendo el frontend..."
  cd frontend
  npm install

  if [ -f "package.json" ]; then
    # Detectar si usa build
    if grep -q "\"build\"" package.json; then
      echo "🏗️ Ejecutando npm run build..."
      npm run build
    else
      echo "⚠️ package.json del frontend no tiene script de build"
    fi
  fi

  echo "✔️ Frontend compilado"
  cd ..
else
  echo "⚠️ No se encontró carpeta /frontend"
fi

echo "🎉 Build completado correctamente"
