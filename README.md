# 📱 Web → Native Converter

![Electron](https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Capacitor](https://img.shields.io/badge/Capacitor-119EFF?style=for-the-badge&logo=capacitor&logoColor=white)
![License](https://img.shields.io/badge/Licencia-MIT-green?style=for-the-badge)

> **Convierte cualquier proyecto web en APK Android o IPA iOS con un solo clic.**

Convierte cualquier proyecto web (React, Vue, Angular, Svelte, HTML estático...) a una app nativa **Android APK** o **iOS IPA** con un solo clic.

![App Screenshot](assets/screenshot.png)

## ✨ Características

- **Detector automático de framework** — detecta React, Vue, Angular, Svelte, Next.js, Nuxt, Vite...
- **Conversión con Capacitor** — usa la tecnología estándar de la industria
- **Barra de progreso en tiempo real** — con indicador porcentual y paso actual
- **Terminal de logs completo** — ve exactamente qué pasa en cada momento
- **Timeline visual de pasos** — 8 etapas con estados visual (pendiente / activo / completado / error)
- **Soporte Android y iOS** — genera APK debug/release o IPA
- **Drag & Drop** — arrastra la carpeta del proyecto directamente a la app
- **Cross-platform** — funciona en Linux, Windows y macOS

## 🚀 Inicio rápido

```bash
# 1. Instalar dependencias y lanzar
chmod +x setup.sh && ./setup.sh

# O manualmente:
npm install
npm start
```

## 📋 Requisitos del sistema

### Para compilar APK (Android)

| Requisito | Versión mínima | Descarga |
|-----------|----------------|----------|
| Node.js   | 18+            | https://nodejs.org |
| Java JDK  | 17+            | https://adoptium.net |
| Android Studio + SDK | Latest | https://developer.android.com/studio |

Además configura la variable de entorno:
```bash
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/tools:$ANDROID_HOME/platform-tools
```

### Para compilar IPA (iOS) — Solo macOS

| Requisito | Versión |
|-----------|---------|
| Xcode     | 15+     |
| CocoaPods | Latest  |

```bash
sudo gem install cocoapods
```

## 🛠 Cómo funciona

1. **Selecciona tu proyecto** web (o arrástralo)
2. **Configura** nombre, Bundle ID y plataforma
3. **Presiona Convertir** — la app:
   - Copia el proyecto a un directorio temporal
   - Ejecuta `npm run build` (opcional)
   - Instala e inicializa Capacitor
   - Agrega la plataforma nativa
   - Sincroniza los assets web
   - Compila con Gradle (Android) o Xcode (iOS)
   - Copia el APK/IPA a tu carpeta de salida

## 📁 Estructura del proyecto

```
web-converter/
├── main.js          ← Electron main process + lógica de conversión
├── preload.js       ← Bridge seguro renderer ↔ main
├── renderer/
│   ├── index.html   ← UI principal
│   ├── styles.css   ← Estilos (dark theme)
│   └── app.js       ← Lógica del frontend
├── assets/          ← Iconos
└── package.json
```

## 🏗 Compilar ejecutable

```bash
# Linux (AppImage + .deb)
npm run build:linux

# Windows (.exe)
npm run build:win

# macOS (.dmg)  — solo en Mac
npm run build:mac
```

El ejecutable se genera en la carpeta `dist/`.

## ⚠️ Notas importantes

- La compilación de APK puede tardar **3-10 minutos** la primera vez (descarga Gradle y dependencias de Android)
- La compilación de iOS requiere **macOS** y puede tardar **5-15 minutos**
- El APK generado en modo **debug** puede instalarse directamente en dispositivos con "Instalar desde fuentes desconocidas" activado
- Para publicar en Google Play o App Store necesitarás firmar la app con un keystore/certificado

## 🤝 Frameworks soportados

| Framework | Build command | Carpeta de salida |
|-----------|--------------|-------------------|
| React (CRA) | `npm run build` | `build/` |
| React + Vite | `npm run build` | `dist/` |
| Vue 3 | `npm run build` | `dist/` |
| Angular | `npm run build` | `dist/` |
| Svelte | `npm run build` | `dist/` |
| Next.js | `npm run build` | `.next/` |
| Nuxt | `npm run build` | `.output/` |
| HTML estático | — | raíz del proyecto |

<!-- Agrega capturas en docs/screenshots/ -->

---

## Desarrollado por Francisco Javier Laguna

Full-stack developer · React · Vue · .NET · PHP

[GitHub](https://github.com/jlaguna553) · [LinkedIn](https://www.linkedin.com/in/francisco-javier-laguna-mondrag%C3%B3n-80a798154/) · [CV Online](https://cv-online.jlaguna553.workers.dev/v/xrdcnyej)
