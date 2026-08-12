#!/usr/bin/env bash
# ============================================================
# Web to Native Converter — Setup & Launch Script
# ============================================================
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Web → Native Converter  v1.0.0    ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── Check Node.js ─────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js no encontrado. Instala desde https://nodejs.org${NC}"
  exit 1
fi

NODE_VER=$(node -v | cut -c2- | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${YELLOW}⚠  Node.js v$NODE_VER detectado. Se recomienda v18+${NC}"
fi

echo -e "${GREEN}✓ Node.js $(node -v) detectado${NC}"

# ── Install dependencies ───────────────────────────────────────
echo -e "\n${CYAN}📦 Instalando dependencias...${NC}"
npm install

echo -e "\n${GREEN}✅ Instalación completada.${NC}"
echo ""
echo -e "${CYAN}📋 Requisitos para compilar apps nativas:${NC}"
echo ""
echo -e "  ${BOLD}Android (APK):${NC}"
echo "    - Java JDK 17+ → https://adoptium.net"
echo "    - Android Studio + SDK → https://developer.android.com/studio"
echo "    - Variable ANDROID_HOME apuntando al SDK"
echo ""
echo -e "  ${BOLD}iOS (IPA) — Solo macOS:${NC}"
echo "    - Xcode 15+ (App Store)"
echo "    - CocoaPods: sudo gem install cocoapods"
echo ""

# ── Launch ─────────────────────────────────────────────────────
echo -e "${CYAN}🚀 Iniciando aplicación...${NC}\n"
npm start
