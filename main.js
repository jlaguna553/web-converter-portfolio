const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const os = require('os');

let mainWindow;
let activeProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1117',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ────────────────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Seleccionar proyecto web'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('select-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Seleccionar carpeta de salida'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('analyze-project', async (event, projectPath) => {
  return analyzeWebProject(projectPath);
});

ipcMain.handle('check-requirements', async (event, platform) => {
  return checkRequirements(platform);
});

ipcMain.handle('start-conversion', async (event, config) => {
  try {
    await startConversion(config, (type, data) => {
      mainWindow.webContents.send('conversion-event', { type, data });
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cancel-conversion', async () => {
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
    activeProcess = null;
    return true;
  }
  return false;
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('get-platform', () => process.platform);

// ─── Project Analysis ─────────────────────────────────────────────────────────

function analyzeWebProject(projectPath) {
  const result = {
    valid: false,
    framework: 'unknown',
    hasPackageJson: false,
    hasBuildOutput: false,
    buildDir: null,
    entryPoint: null,
    name: path.basename(projectPath),
    warnings: [],
    errors: []
  };

  if (!fs.existsSync(projectPath)) {
    result.errors.push('La ruta del proyecto no existe.');
    return result;
  }

  const files = fs.readdirSync(projectPath);

  // Check package.json
  let pkg = null;
  if (files.includes('package.json')) {
    result.hasPackageJson = true;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
      result.name = pkg.name || result.name;

      // Detect framework
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['react-scripts']) { result.framework = 'react-cra'; }
      else if (deps['react'] || deps['react-dom']) result.framework = 'react';
      if (deps['vue']) result.framework = 'vue';
      if (deps['@angular/core']) result.framework = 'angular';
      if (deps['svelte']) result.framework = 'svelte';
      if (deps['next']) result.framework = 'next';
      if (deps['nuxt']) result.framework = 'nuxt';
      if (deps['gatsby']) result.framework = 'gatsby';
      if (deps['vite'] && result.framework === 'unknown') result.framework = 'vite';

      // Detect build output dir from framework
      if (deps['react-scripts']) result.buildDir = 'build';
      else if (deps['next']) result.buildDir = 'out';
      else if (deps['nuxt']) result.buildDir = '.output/public';
      else if (deps['gatsby']) result.buildDir = 'public';
      else if (deps['vite'] || deps['vue'] || deps['svelte']) result.buildDir = 'dist';
      else if (deps['@angular/core']) result.buildDir = 'dist';

      // Fallback: read build script
      if (!result.buildDir && pkg.scripts?.build) {
        const s = pkg.scripts.build;
        if (/--outDir\s+(\S+)/.test(s)) result.buildDir = s.match(/--outDir\s+(\S+)/)[1];
        else if (s.includes('build')) result.buildDir = 'build';
        else if (s.includes('dist')) result.buildDir = 'dist';
      }
    } catch (e) {
      result.warnings.push('No se pudo parsear package.json: ' + e.message);
    }
  }

  // Check for build output — only dirs that actually have index.html
  // NOTE: 'public/' is excluded here on purpose (it's React/Vue source assets, not build output)
  // Exception: Svelte (rollup) and Gatsby DO output to public/
  const buildDirs = ['dist', 'build', 'out', 'www', '.output/public', 'dist/browser', 'dist/spa'];
  for (const dir of buildDirs) {
    const dirPath = path.join(projectPath, dir);
    if (fs.existsSync(dirPath) && fs.existsSync(path.join(dirPath, 'index.html'))) {
      result.hasBuildOutput = true;
      result.buildDir = result.buildDir || dir;
      break;
    }
  }

  // Svelte (rollup template) and Gatsby output to public/ WITH index.html
  if (!result.hasBuildOutput) {
    const publicPath = path.join(projectPath, 'public');
    if (fs.existsSync(publicPath) && fs.existsSync(path.join(publicPath, 'index.html'))) {
      // Only count as build output if it's Svelte/Gatsby (otherwise it's React source assets)
      const isSvelte = !!(pkg?.dependencies?.svelte || pkg?.devDependencies?.svelte);
      const isGatsby = !!(pkg?.dependencies?.gatsby);
      if (isSvelte || isGatsby) {
        result.hasBuildOutput = true;
        result.buildDir = 'public';
      }
    }
  }

  // Check for direct index.html in root
  if (!result.hasBuildOutput && files.includes('index.html')) {
    result.hasBuildOutput = true;
    result.buildDir = '.';
    result.entryPoint = 'index.html';
  }

  // Validation
  if (!result.hasPackageJson && !files.includes('index.html')) {
    result.errors.push('No se encontró package.json ni index.html. ¿Es un proyecto web válido?');
  } else {
    result.valid = true;
  }

  if (result.valid && !result.hasBuildOutput && result.hasPackageJson) {
    result.warnings.push('No se encontró carpeta de build. Se ejecutará "npm run build" automáticamente.');
  }

  // Next.js info — will be auto-patched during conversion
  if (result.framework === 'next') {
    const nextConfig = ['next.config.js', 'next.config.ts', 'next.config.mjs'].find(
      f => fs.existsSync(path.join(projectPath, f))
    );
    const hasStaticExport = nextConfig
      ? /output\s*:\s*['"`]export['"`]/.test(fs.readFileSync(path.join(projectPath, nextConfig), 'utf8'))
      : false;
    if (!hasStaticExport) {
      result.warnings.push(
        'Proyecto Next.js: se añadirá output:"export" automáticamente durante la conversión ' +
        '(solo en la copia temporal — tu proyecto original no se modifica).'
      );
    }
  }

  // SvelteKit info
  if (pkg && (pkg.dependencies?.['@sveltejs/kit'] || pkg.devDependencies?.['@sveltejs/kit'])) {
    const svelteConfig = path.join(projectPath, 'svelte.config.js');
    const hasStaticAdapter = fs.existsSync(svelteConfig) &&
      /adapter-static/.test(fs.readFileSync(svelteConfig, 'utf8'));
    if (!hasStaticAdapter) {
      result.warnings.push(
        'SvelteKit: se instalará @sveltejs/adapter-static automáticamente durante la conversión.'
      );
    }
  }

  return result;
}

// ─── Requirements Check ───────────────────────────────────────────────────────

async function checkRequirements(platform) {
  const checks = [];

  // Node.js
  checks.push({ name: 'Node.js', ...await checkCommand('node --version') });
  // npm
  checks.push({ name: 'npm', ...await checkCommand('npm --version') });
  // Java (for Android)
  if (platform === 'android' || platform === 'both') {
    checks.push({ name: 'Java (JDK)', ...await checkCommand('java -version') });
    checks.push({ name: 'Android SDK / ANDROID_HOME', ...checkEnvVar('ANDROID_HOME') });

    // Gradle: NOT required system-wide — Android projects use gradlew (Gradle Wrapper)
    // which auto-downloads the correct Gradle version on first build.
    const gradleSystemCheck = await checkCommand('gradle -version');
    checks.push({
      name: 'Gradle',
      installed: true,  // always OK — gradlew handles it
      version: gradleSystemCheck.installed
        ? gradleSystemCheck.version
        : 'Auto-descarga via Gradle Wrapper (gradlew) ✓',
      warning: null
    });

    // Check build-tools are present in SDK
    const sdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (sdkPath) {
      const btDir = path.join(sdkPath, 'build-tools');
      const hasBuildTools = fs.existsSync(btDir) &&
        fs.readdirSync(btDir).length > 0;
      checks.push({
        name: 'Android build-tools',
        installed: hasBuildTools,
        version: hasBuildTools
          ? fs.readdirSync(btDir).join(', ')
          : null,
        warning: hasBuildTools ? null : 'Ejecuta: sdkmanager "build-tools;34.0.0"'
      });

      const platformsDir = path.join(sdkPath, 'platforms');
      const hasPlatforms = fs.existsSync(platformsDir) &&
        fs.readdirSync(platformsDir).length > 0;
      checks.push({
        name: 'Android platforms',
        installed: hasPlatforms,
        version: hasPlatforms
          ? fs.readdirSync(platformsDir).join(', ')
          : null,
        warning: hasPlatforms ? null : 'Ejecuta: sdkmanager "platforms;android-34"'
      });
    }
  }
  // Xcode (for iOS)
  if (platform === 'ios' || platform === 'both') {
    if (process.platform === 'darwin') {
      checks.push({ name: 'Xcode', ...await checkCommand('xcodebuild -version') });
      checks.push({ name: 'CocoaPods', ...await checkCommand('pod --version') });
    } else {
      checks.push({
        name: 'iOS build',
        installed: false,
        version: null,
        warning: 'iOS solo puede compilarse en macOS'
      });
    }
  }

  return checks;
}

function checkCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { env: process.env }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim().split('\n')[0];
      resolve({
        installed: !err,
        version: err ? null : output,
        warning: null
      });
    });
  });
}

function checkEnvVar(name) {
  const val = process.env[name] || process.env[name + '_ROOT'];
  return {
    installed: !!val,
    version: val || null,
    warning: val ? null : `Variable ${name} no definida`
  };
}

// ─── Framework Config Patchers ────────────────────────────────────────────────

/**
 * Patches framework config files in the WORK COPY (never the original project)
 * so that `npm run build` produces a static export compatible with Capacitor.
 */
async function patchFrameworkConfig(workDir, log) {
  const pkgPath = path.join(workDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // ── Next.js ────────────────────────────────────────────────────────────────
  if (deps['next']) {
    await patchNextConfig(workDir, log);
    return;
  }

  // ── Nuxt 3 ────────────────────────────────────────────────────────────────
  if (deps['nuxt']) {
    await patchNuxtConfig(workDir, log);
    return;
  }

  // ── SvelteKit ─────────────────────────────────────────────────────────────
  if (deps['@sveltejs/kit']) {
    await patchSvelteKitConfig(workDir, log);
    return;
  }

  // CRA / Vite / Vue / Angular don't need patching — they produce static output by default
}

function getNextJsVersion(workDir) {
  try {
    const pkgPath = path.join(workDir, 'node_modules', 'next', 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const ver = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '';
    return ver;
  } catch { return null; }
}

async function patchNextConfig(workDir, log) {
  log('🔧 Next.js detectado — preparando para export estático...');

  // ── 1. Patch / create next.config ────────────────────────────────────────
  const configNames = ['next.config.js', 'next.config.ts', 'next.config.mjs', 'next.config.cjs'];
  let configPatched = false;

  for (const name of configNames) {
    const configPath = path.join(workDir, name);
    if (!fs.existsSync(configPath)) continue;

    let src = fs.readFileSync(configPath, 'utf8');
    const alreadyExport = /output\s*:\s*['"`]export['"`]/.test(src);

    if (!alreadyExport) {
      src = injectNextOption(src, 'output: "export"');
    }
    if (!/unoptimized\s*:\s*true/.test(src)) {
      src = injectNextOption(src, 'images: { unoptimized: true }');
    }
    if (!/trailingSlash/.test(src)) {
      src = injectNextOption(src, 'trailingSlash: true');
    }

    fs.writeFileSync(configPath, src);
    log(`  → ✅ ${name}: output:"export" + images.unoptimized + trailingSlash`);
    configPatched = true;
    break;
  }

  if (!configPatched) {
    fs.writeFileSync(path.join(workDir, 'next.config.js'),
`/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
module.exports = nextConfig;
`);
    log('  → ✅ next.config.js creado con output:"export"');
  }

  // ── Always inject typescript + eslint ignore flags ────────────────────────
  // These are needed because our stubs may not perfectly match TS types.
  for (const name of configNames) {
    const configPath = path.join(workDir, name);
    if (!fs.existsSync(configPath)) continue;
    let src = fs.readFileSync(configPath, 'utf8');
    let changed = false;
    if (!/ignoreBuildErrors/.test(src)) {
      src = injectNextOption(src, 'typescript: { ignoreBuildErrors: true }');
      changed = true;
    }
    if (!/ignoreDuringBuilds/.test(src)) {
      src = injectNextOption(src, 'eslint: { ignoreDuringBuilds: true }');
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(configPath, src);
      log('  → ✅ TypeScript + ESLint: ignoreBuildErrors/ignoreDuringBuilds activados');
    }
    break;
  }

  // ── 2. Remove API routes (server-side only, not bundled in the app) ───────
  // The mobile app will call these endpoints via HTTP to the deployed server.
  const apiDirs = [
    path.join(workDir, 'app', 'api'),
    path.join(workDir, 'src', 'app', 'api'),
    path.join(workDir, 'pages', 'api'),
    path.join(workDir, 'src', 'pages', 'api'),
  ];
  for (const dir of apiDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`  → 🗑️  Eliminado ${path.relative(workDir, dir)}/ (API routes corren en servidor, no en la app)`);
    }
  }

  // ── 3. Remove server-only special routes ──────────────────────────────────
  // manifest, sitemap, robots, opengraph-image — these are route handlers
  // incompatible with output:export. Replace manifest with a static file.
  const serverRoutes = [
    'app/manifest.ts', 'app/manifest.js',
    'src/app/manifest.ts', 'src/app/manifest.js',
    'app/sitemap.ts', 'app/sitemap.js',
    'src/app/sitemap.ts', 'src/app/sitemap.js',
    'app/robots.ts', 'app/robots.js',
    'src/app/robots.ts', 'src/app/robots.js',
    'app/opengraph-image.tsx', 'app/opengraph-image.ts',
    'src/app/opengraph-image.tsx', 'src/app/opengraph-image.ts',
  ];
  for (const rel of serverRoutes) {
    const p = path.join(workDir, rel);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      log(`  → 🗑️  Eliminado ${rel} (route handler incompatible con static export)`);
    }
  }

  // Also remove any route.ts/route.js inside app/ that aren't page routes
  removeServerRouteHandlers(workDir, log);

  // ── 4. Replace force-dynamic with force-static in page files ─────────────
  patchForceDynamic(workDir, log);

  // ── 5. Stub next/headers (cookies, headers, draftMode) ────────────────────
  // cookies()/headers() are server-only APIs incompatible with static export.
  // We replace their imports with inline stubs so pages render statically.
  stubNextHeaders(workDir, log);

  // ── 6. Stub next/server auth guards (NextResponse.redirect in middleware) ──
  patchMiddleware(workDir, log);

  // ── 7. Create simple static not-found page ────────────────────────────────
  ensureStaticNotFound(workDir, log);

  // ── 8. Create static manifest.json if not present ─────────────────────────
  const publicDir = path.join(workDir, 'public');
  if (!fs.existsSync(path.join(publicDir, 'manifest.json')) &&
      !fs.existsSync(path.join(publicDir, 'manifest.webmanifest'))) {
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    const appName = path.basename(workDir);
    fs.writeFileSync(path.join(publicDir, 'manifest.json'), JSON.stringify({
      name: appName,
      short_name: appName,
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#000000',
      icons: []
    }, null, 2));
    log('  → ✅ Creado public/manifest.json estático');
  }
}

/**
 * Removes route.ts/route.js files inside app/ directories (except page/layout/etc.)
 * These are API-like handlers incompatible with output:export.
 */
function removeServerRouteHandlers(workDir, log) {
  const appRoots = [
    path.join(workDir, 'app'),
    path.join(workDir, 'src', 'app'),
  ];
  for (const appRoot of appRoots) {
    if (!fs.existsSync(appRoot)) continue;
    walkDir(appRoot, (filePath) => {
      const basename = path.basename(filePath);
      // route.ts / route.js are API route handlers in App Router
      if (basename === 'route.ts' || basename === 'route.js') {
        fs.rmSync(filePath, { force: true });
        log(`  → 🗑️  Eliminado ${path.relative(workDir, filePath)} (route handler)`);
      }
    });
  }
}

/**
 * Replaces `export const dynamic = "force-dynamic"` with `force-static`
 * in all page files so they can be statically exported.
 */
function patchForceDynamic(workDir, log) {
  const roots = [
    path.join(workDir, 'app'),
    path.join(workDir, 'src', 'app'),
    path.join(workDir, 'pages'),
    path.join(workDir, 'src', 'pages'),
  ];
  let count = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walkDir(root, (filePath) => {
      if (!/\.(ts|tsx|js|jsx)$/.test(filePath)) return;
      try {
        const src = fs.readFileSync(filePath, 'utf8');
        if (!/force-dynamic/.test(src)) return;
        const patched = src.replace(
          /export\s+const\s+dynamic\s*=\s*['"`]force-dynamic['"`]/g,
          'export const dynamic = "force-static"'
        );
        if (patched !== src) {
          fs.writeFileSync(filePath, patched);
          count++;
        }
      } catch {}
    });
  }
  if (count > 0) log(`  → ✅ ${count} archivo(s): force-dynamic → force-static`);
}

/**
 * Replaces `import { cookies/headers/draftMode } from 'next/headers'`
 * with inline stub functions compatible with static export.
 * Also stubs `import { getServerSession } from 'next-auth'`.
 */
function stubNextHeaders(workDir, log) {
  const sourceDirs = ['app', 'src', 'components', 'lib', 'utils', 'hooks', 'context', 'store']
    .map(d => path.join(workDir, d))
    .filter(d => fs.existsSync(d));

  let count = 0;
  for (const dir of sourceDirs) {
    walkDir(dir, (filePath) => {
      if (!/\.(ts|tsx|js|jsx|mts|mjs)$/.test(filePath)) return;
      try {
        let src = fs.readFileSync(filePath, 'utf8');
        if (!/next\/headers|next-auth/.test(src)) return;
        const original = src;

        // ── next/headers stubs ────────────────────────────────────────────
        // TypeScript files use (..._a: any[]) so TS accepts calls with any args.
        // JS files use plain rest params.
        const isTS = /\.(ts|tsx|mts)$/.test(filePath);
        const anyType = isTS ? ': any' : '';
        const anyParam = isTS ? '..._a: any[]' : '..._a';
        src = src.replace(
          /import\s*\{([^}]+)\}\s*from\s*['"]next\/headers['"]\s*;?/g,
          (_, imports) => {
            const names = imports.split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
            return names.map(n => {
              if (n === 'cookies')   return `const cookies = (${anyParam})${anyType} => Promise.resolve({ get: (${anyParam})${anyType} => undefined, getAll: (${anyParam})${anyType} => [], has: (${anyParam})${anyType} => false, set: (${anyParam})${anyType} => {}, delete: (${anyParam})${anyType} => {}, [Symbol.iterator]: function*(){} })`;
              if (n === 'headers')   return `const headers = (${anyParam})${anyType} => new Headers()`;
              if (n === 'draftMode') return `const draftMode = (${anyParam})${anyType} => ({ isEnabled: false, enable: () => {}, disable: () => {} })`;
              return `const ${n} = (${anyParam})${anyType} => undefined`;
            }).join(';\n') + ';';
          }
        );

        // ── next-auth/next stubs (getServerSession) ────────────────────────
        src = src.replace(
          /import\s*\{([^}]+)\}\s*from\s*['"]next-auth\/next['"]\s*;?/g,
          (_, imports) => {
            const names = imports.split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
            return names.map(n => {
              if (n === 'getServerSession') return `const getServerSession = async () => null`;
              return `const ${n} = () => null`;
            }).join(';\n') + ';';
          }
        );

        // ── next-auth stubs ────────────────────────────────────────────────
        src = src.replace(
          /import\s+\w+\s+from\s*['"]next-auth['"]\s*;?/g,
          `const NextAuth = (opts) => ({ handlers: {}, auth: async () => null, signIn: async () => {}, signOut: async () => {} });`
        );

        if (src !== original) {
          fs.writeFileSync(filePath, src);
          count++;
        }
      } catch {}
    });
  }
  if (count > 0) log(`  → ✅ ${count} archivo(s): next/headers + next-auth → stubs estáticos`);
  else log('  → next/headers: no se encontraron imports que parchear');
}

/**
 * Removes or stubs middleware.ts/js — it runs on the server edge,
 * not compatible with static export and can cause build errors.
 */
function patchMiddleware(workDir, log) {
  const middlewarePaths = [
    path.join(workDir, 'middleware.ts'),
    path.join(workDir, 'middleware.js'),
    path.join(workDir, 'src', 'middleware.ts'),
    path.join(workDir, 'src', 'middleware.js'),
  ];
  for (const p of middlewarePaths) {
    if (!fs.existsSync(p)) continue;
    // Replace with a passthrough middleware (no auth redirects)
    fs.writeFileSync(p,
`// Auto-stub: middleware desactivado para export estático (Web→Native Converter)
// En producción el middleware original maneja auth/redirects en el servidor.
export function middleware() {}
export const config = { matcher: [] };
`);
    log(`  → ✅ ${path.relative(workDir, p)}: middleware → passthrough estático`);
  }
}

/**
 * Ensures app/not-found.tsx is a simple static page with no server dependencies.
 * If the existing one has issues, replaces it.
 */
function ensureStaticNotFound(workDir, log) {
  const candidates = [
    { dir: path.join(workDir, 'app'),       ext: 'tsx' },
    { dir: path.join(workDir, 'src', 'app'), ext: 'tsx' },
  ];
  for (const { dir, ext } of candidates) {
    if (!fs.existsSync(dir)) continue;
    const p = path.join(dir, `not-found.${ext}`);
    if (fs.existsSync(p)) {
      const src = fs.readFileSync(p, 'utf8');
      // If it uses any server-only APIs, replace it
      if (/cookies\(\)|headers\(\)|getServerSession|next\/headers/.test(src)) {
        fs.writeFileSync(p, STATIC_NOT_FOUND_TSX);
        log(`  → ✅ app/not-found.${ext}: reemplazado con versión estática`);
      }
    } else {
      // Create one to avoid inheriting a broken root layout chain
      fs.writeFileSync(p, STATIC_NOT_FOUND_TSX);
      log(`  → ✅ app/not-found.${ext}: creado (página estática)`);
    }
    break;
  }
}

const STATIC_NOT_FOUND_TSX = `// Auto-generado por Web→Native Converter
export default function NotFound() {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'100vh', fontFamily:'sans-serif' }}>
      <h1 style={{ fontSize:'4rem', margin:0 }}>404</h1>
      <p style={{ color:'#666' }}>Página no encontrada</p>
    </div>
  );
}
`;

/** Recursive directory walker */
function walkDir(dir, cb) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkDir(full, cb);
      else cb(full);
    }
  } catch {}
}

/** Injects a key:value option into the first object literal found in a Next.js config. */
function injectNextOption(src, option) {
  // Handles: module.exports = { ... }, export default { ... }, const x = { ... }
  // Injects right after the opening brace of the config object
  const patterns = [
    /(module\.exports\s*=\s*\{)/,
    /(export\s+default\s*\{)/,
    /(const\s+\w+\s*(?::\s*\w+\s*)?\s*=\s*\{)/,
    /(nextConfig\s*=\s*\{)/,
  ];
  for (const pat of patterns) {
    if (pat.test(src)) {
      return src.replace(pat, `$1\n  ${option},`);
    }
  }
  return src; // couldn't find a pattern, return unchanged
}

async function patchNuxtConfig(workDir, log) {
  log('🔧 Nuxt detectado — verificando configuración de SSG...');
  const configNames = ['nuxt.config.js', 'nuxt.config.ts'];
  for (const name of configNames) {
    const p = path.join(workDir, name);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    // Nuxt 3 static generation: ssr: false or nitro.preset: 'static'
    if (/ssr\s*:\s*false/.test(src) || /preset\s*:\s*['"`]static['"`]/.test(src)) {
      log('  → Nuxt SSG config detectada ✅');
      return;
    }
    // Inject ssr: false
    const patched = src.replace(
      /(defineNuxtConfig\s*\(\s*\{|export\s+default\s*\{)/,
      `$1\n  ssr: false,`
    );
    if (patched !== src) {
      fs.writeFileSync(p, patched);
      log('  → ✅ ' + name + ' parcheado: ssr:false para build estático');
    }
    return;
  }
}

async function patchSvelteKitConfig(workDir, log) {
  log('🔧 SvelteKit detectado — verificando adapter...');
  const configPath = path.join(workDir, 'svelte.config.js');
  if (!fs.existsSync(configPath)) return;
  const src = fs.readFileSync(configPath, 'utf8');
  if (/adapter-static/.test(src)) {
    log('  → adapter-static ya configurado ✅');
    return;
  }
  // Install adapter-static and patch config
  log('  → Instalando @sveltejs/adapter-static...');
  await runCommand('npm', ['install', '-D', '@sveltejs/adapter-static'], workDir, log);
  const patched = src
    .replace(/import\s+adapter\s+from\s+['"`]@sveltejs\/adapter-\w+['"`]/, `import adapter from '@sveltejs/adapter-static'`)
    .replace(/(adapter\s*:\s*adapter\s*\(\s*\{)/, `$1\n      fallback: 'index.html',`);
  fs.writeFileSync(configPath, patched !== src ? patched : src.replace(
    /adapter\s*:\s*adapter\(\)/,
    `adapter: adapter({ fallback: 'index.html' })`
  ));
  log('  → ✅ svelte.config.js actualizado con adapter-static');
}

// ─── Conversion Engine ────────────────────────────────────────────────────────

async function startConversion(config, emit) {
  const {
    projectPath,
    outputPath,
    appName,
    appId,
    appVersion,
    platform,
    buildFirst,
    signingMode
  } = config;

  const workDir = path.join(os.tmpdir(), `webconv_${Date.now()}`);
  const steps = buildStepList(platform, buildFirst);
  let currentStep = 0;
  const totalSteps = steps.length;

  const log = (msg, level = 'info') => {
    emit('log', { message: msg, level, timestamp: new Date().toISOString() });
  };

  const progress = (step, pct, message) => {
    emit('progress', { step, total: totalSteps, pct, message });
  };

  const fail = (msg) => {
    emit('error', { message: msg });
    throw new Error(msg);
  };

  try {
    // ── STEP: Copy project ────────────────────────────────────────────────
    progress(++currentStep, pctOf(currentStep, totalSteps), 'Copiando proyecto...');
    log(`📁 Directorio de trabajo: ${workDir}`);
    await copyProject(projectPath, workDir, log);
    log('✅ Proyecto copiado correctamente.');

    // ── STEP: Install web dependencies ───────────────────────────────────
    if (buildFirst && fs.existsSync(path.join(workDir, 'package.json'))) {
      progress(++currentStep, pctOf(currentStep, totalSteps), 'Instalando dependencias npm...');
      log('📦 Ejecutando npm install...');
      await runCommand('npm', ['install', '--prefer-offline'], workDir, log);
      log('✅ Dependencias instaladas.');

      // ── Patch framework configs before build ────────────────────────
      await patchFrameworkConfig(workDir, log);

      // ── STEP: Build web project ─────────────────────────────────────
      progress(++currentStep, pctOf(currentStep, totalSteps), 'Compilando proyecto web...');
      log('🔨 Ejecutando npm run build...');
      await runCommand('npm', ['run', 'build'], workDir, log);
      log('✅ Build del proyecto web completado.');

      // ── Post-build: Next.js legacy export ───────────────────────────
      // For Next.js < 13.3 that doesn't support output:"export" in config
      const nextVersion = getNextJsVersion(workDir);
      if (nextVersion && !fs.existsSync(path.join(workDir, 'out', 'index.html'))) {
        log('📤 next build no generó out/ — intentando next export (modo legacy)...', 'warn');
        try {
          await runCommand('npx', ['next', 'export'], workDir, log, 180000);
          log('✅ next export completado.');
        } catch (exportErr) {
          log(`⚠️  next export falló: ${exportErr.message}`, 'warn');
          log('   Puede que el proyecto use Server Components o API Routes que no son exportables.', 'warn');
        }
      }
    }

    // ── STEP: Find web root ───────────────────────────────────────────────
    progress(++currentStep, pctOf(currentStep, totalSteps), 'Detectando directorio de salida web...');
    const webRootResult = findWebRoot(workDir, log);

    if (!webRootResult) {
      // List actual dirs to help debug
      const dirs = fs.readdirSync(workDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .join(', ');
      fail(
        `No se encontró ningún index.html en el directorio de build.\n` +
        `Directorios existentes: ${dirs || '(ninguno)'}\n\n` +
        `Causas comunes:\n` +
        `  • "npm run build" falló o no generó archivos\n` +
        `  • La carpeta de salida no es estándar (dist, build, out, www)\n` +
        `  • Next.js necesita output:"export" en next.config.js para generar archivos estáticos\n` +
        `  • Prueba compilar el proyecto manualmente primero y desmarca "Ejecutar npm run build"`
      );
    }

    const { dir: webDirAbs, rel: relWebDir } = webRootResult;
    log(`🌐 Directorio web: /${relWebDir}  →  ${webDirAbs}`);

    // ── STEP: Install Capacitor ───────────────────────────────────────────
    progress(++currentStep, pctOf(currentStep, totalSteps), 'Instalando Capacitor...');
    log('⚡ Instalando @capacitor/core y @capacitor/cli...');
    await runCommand('npm', ['install', '@capacitor/core', '@capacitor/cli', '--save'], workDir, log);
    log('✅ Capacitor core instalado.');

    // ── STEP: Init Capacitor ──────────────────────────────────────────────
    progress(++currentStep, pctOf(currentStep, totalSteps), 'Inicializando Capacitor...');
    log(`🔧 Inicializando Capacitor: ${appName} (${appId})`);

    await initCapacitor(workDir, appName, appId, relWebDir, log);
    log('✅ Capacitor inicializado.');

    // ── STEP: Add platform ────────────────────────────────────────────────
    const platforms = platform === 'both' ? ['android', 'ios'] : [platform];

    for (const plt of platforms) {
      progress(++currentStep, pctOf(currentStep, totalSteps), `Agregando plataforma ${plt}...`);
      log(`📱 Instalando @capacitor/${plt}...`);
      await runCommand('npm', ['install', `@capacitor/${plt}`, '--save'], workDir, log);
      log(`➕ Ejecutando: npx cap add ${plt}`);
      await runCommand('npx', ['cap', 'add', plt], workDir, log);
      log(`✅ Plataforma ${plt} agregada.`);

      // ── STEP: Sync ──────────────────────────────────────────────────
      progress(++currentStep, pctOf(currentStep, totalSteps), `Sincronizando ${plt}...`);
      log(`🔄 Sincronizando assets: npx cap sync ${plt}`);
      await runCommand('npx', ['cap', 'sync', plt], workDir, log);
      log(`✅ Sync ${plt} completado.`);

      // ── POST-SYNC: WebView compatibility fixes ───────────────────────
      if (plt === 'android') {
        await patchAndroidWebViewCompat(workDir, log);
      }

      // ── STEP: Build native ──────────────────────────────────────────
      if (plt === 'android') {
        progress(++currentStep, pctOf(currentStep, totalSteps), 'Compilando APK Android...');
        log('🤖 Compilando APK con Gradle...');
        await buildAndroid(workDir, signingMode, log);
        const apkPath = findApk(workDir);
        if (!apkPath) fail('No se encontró el APK generado.');
        log(`✅ APK generado: ${apkPath}`);

        // Copy to output
        const outFile = path.join(outputPath, `${sanitize(appName)}-${appVersion}.apk`);
        fs.copyFileSync(apkPath, outFile);
        log(`📦 APK guardado en: ${outFile}`);
        emit('output-file', { platform: 'android', path: outFile });
      }

      if (plt === 'ios') {
        if (process.platform !== 'darwin') {
          log('⚠️  iOS build solo disponible en macOS. Saltando...', 'warn');
          continue;
        }
        progress(++currentStep, pctOf(currentStep, totalSteps), 'Compilando IPA iOS...');
        log('🍎 Compilando IPA con xcodebuild...');
        await buildIOS(workDir, appName, appId, appVersion, log);
        const ipaPath = findIPA(workDir);
        if (!ipaPath) fail('No se encontró el IPA generado.');
        log(`✅ IPA generado: ${ipaPath}`);

        const outFile = path.join(outputPath, `${sanitize(appName)}-${appVersion}.ipa`);
        fs.copyFileSync(ipaPath, outFile);
        log(`📦 IPA guardado en: ${outFile}`);
        emit('output-file', { platform: 'ios', path: outFile });
      }
    }

    // Cleanup
    progress(totalSteps, 100, 'Limpiando archivos temporales...');
    log('🧹 Limpiando directorio temporal...');
    fs.rmSync(workDir, { recursive: true, force: true });
    log('✅ Limpieza completada.');

    emit('done', { success: true });

  } catch (err) {
    log(`❌ Error fatal: ${err.message}`, 'error');
    // Try cleanup
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    emit('done', { success: false, error: err.message });
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildStepList(platform, buildFirst) {
  const steps = ['copy'];
  if (buildFirst) { steps.push('npm-install', 'npm-build'); }
  steps.push('detect-web-root', 'cap-install', 'cap-init');
  const platforms = platform === 'both' ? ['android', 'ios'] : [platform];
  for (const p of platforms) {
    steps.push(`add-${p}`, `sync-${p}`, `build-${p}`);
  }
  steps.push('cleanup');
  return steps;
}

function pctOf(current, total) {
  return Math.round((current / total) * 100);
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
}

async function copyProject(src, dest, log) {
  // Use native fs copy with filter for node_modules
  await fsCopyRecursive(src, dest, (name) => name !== 'node_modules' && name !== '.git');
}

function fsCopyRecursive(src, dest, filter) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      const entries = fs.readdirSync(src, { withFileTypes: true });
      const tasks = entries
        .filter(e => !filter || filter(e.name))
        .map(entry => {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            return fsCopyRecursive(srcPath, destPath, filter);
          } else {
            return new Promise((res, rej) => {
              fs.copyFile(srcPath, destPath, err => err ? rej(err) : res());
            });
          }
        });
      Promise.all(tasks).then(resolve).catch(reject);
    } catch (e) { reject(e); }
  });
}

function findWebRoot(workDir, log) {
  // ── 1. Detect expected output dir from framework config ──────────────
  const fromConfig = detectBuildOutputDir(workDir, log);
  if (fromConfig) {
    const full = path.join(workDir, fromConfig);
    if (fs.existsSync(full) && fs.existsSync(path.join(full, 'index.html'))) {
      log(`  → ✅ Directorio detectado por config: /${fromConfig}`);
      return { dir: full, rel: fromConfig };
    }
    if (fs.existsSync(full)) {
      log(`  → ⚠️  /${fromConfig} existe pero sin index.html aún (puede que el build falló)`);
    }
  }

  // ── 2. Scan known build output dirs — ONLY if they have index.html ───
  const candidates = ['dist', 'build', 'www', 'out', '.output/public', 'dist/browser', 'dist/spa'];
  // NOTE: 'public' is intentionally excluded — it's the source assets dir in React/Vue,
  // NOT a build output. Only include it if index.html is literally there.
  for (const c of candidates) {
    const p = path.join(workDir, c);
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html'))) {
      log(`  → ✅ Encontrado index.html en /${c}`);
      return { dir: p, rel: c };
    }
  }

  // ── 3. Root itself ────────────────────────────────────────────────────
  if (fs.existsSync(path.join(workDir, 'index.html'))) {
    log('  → ✅ index.html en directorio raíz del proyecto');
    return { dir: workDir, rel: '.' };
  }

  // ── 4. Nothing found — return null so caller can fail clearly ────────
  log('  → ❌ No se encontró index.html en ningún directorio conocido', 'warn');
  log(`  → Buscado en: ${candidates.join(', ')}, raíz`, 'warn');
  return null;
}

/**
 * Reads framework config files to determine where the build output goes.
 * Returns a relative path string, or null if unknown.
 */
function detectBuildOutputDir(workDir, log) {
  // ── vite.config.{js,ts,mjs,cjs} ──────────────────────────────────────
  for (const name of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.cjs']) {
    const p = path.join(workDir, name);
    if (fs.existsSync(p)) {
      try {
        const src = fs.readFileSync(p, 'utf8');
        const m = src.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/);
        if (m) { log(`  → vite.config outDir: "${m[1]}"`); return m[1]; }
      } catch {}
      log('  → vite.config detectado → default: dist');
      return 'dist';
    }
  }

  // ── angular.json ──────────────────────────────────────────────────────
  const angularJson = path.join(workDir, 'angular.json');
  if (fs.existsSync(angularJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(angularJson, 'utf8'));
      const projects = cfg.projects || {};
      const first = Object.keys(projects)[0];
      const outputPath =
        projects[first]?.architect?.build?.options?.outputPath ||
        projects[first]?.targets?.build?.options?.outputPath;
      if (outputPath) {
        // Angular 17+ wraps in /browser
        const browserPath = path.join(workDir, outputPath, 'browser');
        const rel = fs.existsSync(browserPath) ? path.join(outputPath, 'browser') : outputPath;
        log(`  → angular.json outputPath: "${rel}"`);
        return rel;
      }
    } catch {}
    log('  → angular.json detectado → default: dist');
    return 'dist';
  }

  // ── next.config.{js,ts,mjs} ───────────────────────────────────────────
  for (const name of ['next.config.js', 'next.config.ts', 'next.config.mjs']) {
    if (fs.existsSync(path.join(workDir, name))) {
      try {
        const src = fs.readFileSync(path.join(workDir, name), 'utf8');
        const isStatic = /output\s*:\s*['"`]export['"`]/.test(src);
        const distDir = src.match(/distDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
        if (isStatic) {
          log('  → next.config output:"export" detectado → out');
          return distDir || 'out';
        }
        log('  → ⚠️  Next.js sin output:"export". Necesita "next export" para Capacitor.', 'warn');
      } catch {}
      return 'out';
    }
  }

  // ── nuxt.config.{js,ts} ───────────────────────────────────────────────
  for (const name of ['nuxt.config.js', 'nuxt.config.ts']) {
    if (fs.existsSync(path.join(workDir, name))) {
      log('  → nuxt.config detectado → .output/public');
      return '.output/public';
    }
  }

  // ── package.json heuristic ────────────────────────────────────────────
  const pkgPath = path.join(workDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['react-scripts']) {
        log('  → CRA (react-scripts) detectado → build');
        return 'build';
      }
      if (deps['@vue/cli-service']) {
        log('  → Vue CLI detectado → dist');
        return 'dist';
      }
      if (deps['vite'] || deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-vue']) {
        log('  → Vite detectado → dist');
        return 'dist';
      }
      if (deps['@angular/cli'] || deps['@angular-devkit/build-angular']) {
        log('  → Angular CLI detectado → dist');
        return 'dist';
      }
      if (deps['svelte'] && !deps['vite']) {
        log('  → Svelte (rollup) detectado → public');
        // Svelte template with rollup outputs to public/ WITH index.html
        return 'public';
      }
      if (deps['gatsby']) {
        log('  → Gatsby detectado → public');
        return 'public';
      }

      // Build script heuristic
      const buildScript = pkg.scripts?.build || '';
      const outMatch = buildScript.match(/--outDir\s+(\S+)|--out\s+(\S+)/);
      if (outMatch) {
        const dir = outMatch[1] || outMatch[2];
        log(`  → Build script outDir: "${dir}"`);
        return dir;
      }
    } catch {}
  }

  return null;
}

async function initCapacitor(workDir, appName, appId, webDir, log) {
  // Write capacitor.config.json
  const config = {
    appId,
    appName,
    webDir,
    bundledWebRuntime: false,
    server: { androidScheme: 'https' }
  };
  fs.writeFileSync(
    path.join(workDir, 'capacitor.config.json'),
    JSON.stringify(config, null, 2)
  );
  log(`  → capacitor.config.json escrito (webDir: ${webDir})`);

  // Ensure package.json has name field for cap init
  const pkgPath = path.join(workDir, 'package.json');
  let pkg = {};
  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  }
  pkg.name = pkg.name || sanitize(appName);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

/**
 * Post-sync Android WebView compatibility patches.
 * Fixes rendering issues with side menus, drawers, overlays and touch gestures
 * that behave differently inside an Android WebView vs a desktop browser.
 */
async function patchAndroidWebViewCompat(workDir, log) {
  log('📱 Aplicando fixes de compatibilidad WebView...');

  // ── 1. Update capacitor.config.json ──────────────────────────────────────
  const capCfgPath = path.join(workDir, 'capacitor.config.json');
  if (fs.existsSync(capCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(capCfgPath, 'utf8'));
      cfg.android = {
        ...(cfg.android || {}),
        backgroundColor: '#FFFFFFFF',
        allowMixedContent: true,
        captureInput: false,
        webContentsDebuggingEnabled: false,
      };
      cfg.plugins = cfg.plugins || {};
      cfg.plugins.StatusBar = cfg.plugins.StatusBar || {
        overlaysWebView: false,
        style: 'DARK',
        backgroundColor: '#FF000000'
      };
      cfg.plugins.Keyboard = cfg.plugins.Keyboard || {
        resize: 'body',
        resizeOnFullScreen: true
      };
      fs.writeFileSync(capCfgPath, JSON.stringify(cfg, null, 2));
      log('  → ✅ capacitor.config.json: Android WebView settings');
    } catch {}
  }

  // ── 2. Patch HTML assets — already synced into android project ────────────
  // cap sync copies web files to android/app/src/main/assets/public/
  const assetsPublic = path.join(workDir, 'android', 'app', 'src', 'main', 'assets', 'public');
  const webviewCss = `<style id="cap-webview-fix">
/* Web→Native: Android WebView rendering fixes */
:root {
  --safe-area-top: env(safe-area-inset-top, 0px);
  --safe-area-bottom: env(safe-area-inset-bottom, 0px);
  --safe-area-left: env(safe-area-inset-left, 0px);
  --safe-area-right: env(safe-area-inset-right, 0px);
}

/* Prevent pull-to-refresh from hijacking menu swipe gestures */
body, html {
  overscroll-behavior: none;
  -webkit-overflow-scrolling: touch;
}

/* GPU acceleration for menus, drawers, sheets, sidebars */
[role="dialog"], [role="navigation"],
[data-radix-portal] > *, [data-radix-dialog-content],
[data-state="open"], [data-state="closed"],
.drawer, .sidebar, .sheet, .nav-drawer, .menu-panel,
[class*="drawer"], [class*="sidebar"], [class*="Sheet"],
[class*="Dialog"], [class*="Modal"], [class*="Panel"],
[class*="Overlay"], [class*="overlay"] {
  -webkit-transform: translateZ(0);
  transform: translateZ(0);
  will-change: transform;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

/* Fix full-screen overlays/backdrops */
[data-overlay], [data-radix-dialog-overlay],
[aria-hidden="true"][class*="overlay"],
[aria-hidden="true"][class*="backdrop"],
[class*="Overlay"], [class*="Backdrop"] {
  position: fixed !important;
  inset: 0 !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  height: 100dvh !important;
  z-index: 9998 !important;
}

/* Improve touch response — no 300ms tap delay */
button, a, [role="button"],
input, select, textarea {
  touch-action: manipulation;
}

/* Fix: side panel positioned to full height */
[class*="sidebar"], [class*="drawer"],
[class*="Sheet"], [class*="panel"] {
  height: 100% !important;
  height: 100dvh !important;
  max-height: 100dvh !important;
}

/* Prevent text selection while swiping menus */
* { -webkit-tap-highlight-color: transparent; }
</style>`;

  let htmlPatched = 0;
  if (fs.existsSync(assetsPublic)) {
    walkDir(assetsPublic, (filePath) => {
      if (!filePath.endsWith('.html')) return;
      try {
        let html = fs.readFileSync(filePath, 'utf8');
        // Fix viewport meta
        if (html.includes('name="viewport"') || html.includes("name='viewport'")) {
          html = html.replace(
            /<meta[^>]+name=["']viewport["'][^>]*\/?>/i,
            '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">'
          );
        } else {
          html = html.replace('<head>', '<head>\n  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">');
        }
        // Inject CSS
        if (!html.includes('cap-webview-fix')) {
          html = html.replace('</head>', `  ${webviewCss}\n</head>`);
        }
        fs.writeFileSync(filePath, html);
        htmlPatched++;
      } catch {}
    });
  }
  if (htmlPatched > 0) log(`  → ✅ ${htmlPatched} HTML(s): viewport-fit=cover + CSS WebView`);

  // ── 3. AndroidManifest.xml — hardware acceleration + edge-to-edge ─────────
  const manifestPath = path.join(workDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    let manifest = fs.readFileSync(manifestPath, 'utf8');
    let changed = false;

    if (!manifest.includes('hardwareAccelerated')) {
      manifest = manifest.replace(
        /(<activity\b[^>]*)(>)/,
        '$1\n        android:hardwareAccelerated="true"$2'
      );
      changed = true;
    }
    // Allow window softInput to resize — menus need this
    if (!manifest.includes('windowSoftInputMode')) {
      manifest = manifest.replace(
        /(<activity\b[^>]*)(>)/,
        '$1\n        android:windowSoftInputMode="adjustResize"$2'
      );
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(manifestPath, manifest);
      log('  → ✅ AndroidManifest.xml: hardwareAccelerated + windowSoftInputMode');
    }
  }

  // ── 4. res/values/styles.xml — edge-to-edge theme ─────────────────────────
  const stylesPath = path.join(workDir, 'android', 'app', 'src', 'main', 'res', 'values', 'styles.xml');
  if (fs.existsSync(stylesPath)) {
    let styles = fs.readFileSync(stylesPath, 'utf8');
    if (!styles.includes('windowTranslucentStatus') && !styles.includes('windowLayoutInDisplayCutoutMode')) {
      styles = styles.replace(
        '</style>',
        `    <item name="android:windowTranslucentStatus">false</item>
    <item name="android:windowTranslucentNavigation">false</item>
</style>`
      );
      fs.writeFileSync(stylesPath, styles);
      log('  → ✅ styles.xml: status/navigation bar opaque');
    }
  }

  log('  → ✅ WebView fixes aplicados');
}

async function buildAndroid(workDir, signingMode, log) {
  const androidDir = path.join(workDir, 'android');
  if (!fs.existsSync(androidDir)) throw new Error('Directorio android/ no encontrado tras cap add android.');

  const gradlew = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!fs.existsSync(gradlew)) throw new Error('gradlew no encontrado en android/');

  if (process.platform !== 'win32') fs.chmodSync(gradlew, '755');

  // ── Auto-accept SDK licenses ──────────────────────────────────────────────
  const sdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdkPath) {
    // Write license files directly (faster and more reliable than sdkmanager --licenses)
    const licensesDir = path.join(sdkPath, 'licenses');
    try {
      fs.mkdirSync(licensesDir, { recursive: true });
      // These are the standard license hashes accepted by sdkmanager --licenses
      fs.writeFileSync(path.join(licensesDir, 'android-sdk-license'),
        '\n8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n24333f8a63b6825ea9c5514f83c2829b004d1fee\n');
      fs.writeFileSync(path.join(licensesDir, 'android-sdk-preview-license'),
        '\n84831b9409646a918e30573bab4c9c91346d8abd\n');
      fs.writeFileSync(path.join(licensesDir, 'android-googletv-license'),
        '\n601085b94cd77f0b54ff86406957099ebe79c4d6\n');
      fs.writeFileSync(path.join(licensesDir, 'google-gdk-license'),
        '\n33b6a2b64607f11b759f320ef9dff4ae5c47d97a\n');
      fs.writeFileSync(path.join(licensesDir, 'intel-android-extra-license'),
        '\nd975f751698a77b662f1254ddbeed3901e976f5a\n');
      log('  → ✅ Licencias del SDK aceptadas automáticamente');
    } catch (e) {
      log(`  → ⚠️  No se pudieron escribir licencias: ${e.message}`, 'warn');
    }
  }

  // ── Patch gradle.properties for WSL2 compatibility ────────────────────────
  const gradleProps = path.join(androidDir, 'gradle.properties');
  if (fs.existsSync(gradleProps)) {
    let props = fs.readFileSync(gradleProps, 'utf8');
    let changed = false;
    // Increase heap if not set
    if (!/org\.gradle\.jvmargs/.test(props)) {
      props += '\norg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\n';
      changed = true;
    }
    // Disable daemon for CI-like environments
    if (!/org\.gradle\.daemon/.test(props)) {
      props += 'org.gradle.daemon=false\n';
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(gradleProps, props);
      log('  → ✅ gradle.properties: heap=2048m, daemon=false');
    }
  }

  // ── Patch build.gradle Java version ──────────────────────────────────────
  await patchAndroidGradleJavaVersion(androidDir, log);

  // ── Patch Kotlin stdlib duplicate class conflict ───────────────────────
  patchAndroidKotlinConflicts(androidDir, log);

  const task = signingMode === 'release' ? 'assembleRelease' : 'assembleDebug';
  log(`  → Ejecutando gradle ${task}...`);
  await runCommand(gradlew, [task, '--no-daemon', '--warning-mode', 'all'], androidDir, log, 480000);
}

/**
 * Detects the installed Java version and patches ALL build.gradle files
 * reachable from the Android project — including external modules referenced
 * in settings.gradle (e.g. node_modules/@capacitor/android/android/).
 */
async function patchAndroidGradleJavaVersion(androidDir, log) {
  const javaVer = await detectJavaMajorVersion();
  log(`  → Java instalado: versión ${javaVer} — ajustando build.gradle...`);

  // ── 1. Collect all directories to patch ──────────────────────────────────
  const dirsToSearch = new Set([androidDir]);

  // Read settings.gradle to find external module paths
  for (const settingsFile of ['settings.gradle', 'settings.gradle.kts']) {
    const settingsPath = path.join(androidDir, settingsFile);
    if (!fs.existsSync(settingsPath)) continue;
    const src = fs.readFileSync(settingsPath, 'utf8');
    // Match: project(':name').projectDir = new File('../some/path')
    // or:    project(":name").projectDir = new File("../some/path")
    const matches = src.matchAll(/projectDir\s*=\s*new\s+File\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of matches) {
      const resolved = path.resolve(androidDir, m[1]);
      if (fs.existsSync(resolved)) {
        dirsToSearch.add(resolved);
        log(`    → Módulo externo: ${path.relative(path.dirname(androidDir), resolved)}`);
      }
    }
    break;
  }

  // ── 2. Also always check the capacitor-android node_module path ───────────
  // (in case settings.gradle uses a different format)
  const workDir = path.dirname(androidDir);
  const capAndroidPaths = [
    path.join(workDir, 'node_modules', '@capacitor', 'android', 'android'),
    path.join(workDir, 'node_modules', '@capacitor', 'android', 'capacitor'),
  ];
  for (const p of capAndroidPaths) {
    if (fs.existsSync(p)) dirsToSearch.add(p);
  }

  // ── 3. Patch all found build.gradle files ─────────────────────────────────
  let patchedCount = 0;
  for (const dir of dirsToSearch) {
    walkDir(dir, (filePath) => {
      if (!/build\.gradle(\.kts)?$/.test(path.basename(filePath))) return;
      // Skip files deep inside node_modules subdirectories (other packages)
      if (filePath.includes('node_modules') && !filePath.includes('@capacitor')) return;

      try {
        let src = fs.readFileSync(filePath, 'utf8');
        const original = src;

        // JavaVersion.VERSION_21 → JavaVersion.VERSION_17
        src = src.replace(/JavaVersion\.VERSION_(\d+)/g, (_, v) =>
          parseInt(v) > javaVer ? `JavaVersion.VERSION_${javaVer}` : `JavaVersion.VERSION_${v}`
        );
        // jvmTarget = "21" → "17"
        src = src.replace(/jvmTarget\s*=\s*["'](\d+)["']/g, (_, v) =>
          `jvmTarget = "${parseInt(v) > javaVer ? javaVer : v}"`
        );
        // sourceCompatibility = 21
        src = src.replace(/(sourceCompatibility|targetCompatibility)\s*=\s*(\d+)/g, (_, k, v) =>
          `${k} = ${parseInt(v) > javaVer ? javaVer : v}`
        );
        // sourceCompatibility JavaVersion.VERSION_21 (no =)
        src = src.replace(/(sourceCompatibility|targetCompatibility)\s+JavaVersion\.VERSION_(\d+)/g, (_, k, v) =>
          `${k} JavaVersion.VERSION_${parseInt(v) > javaVer ? javaVer : v}`
        );

        if (src !== original) {
          fs.writeFileSync(filePath, src);
          patchedCount++;
          log(`    → ✅ ${path.relative(workDir, filePath)}`);
        }
      } catch {}
    });
  }

  if (patchedCount > 0) log(`  → ✅ ${patchedCount} build.gradle(s) ajustados a Java ${javaVer}`);
  else log(`  → build.gradle ya compatible con Java ${javaVer} (sin cambios necesarios)`);
}

/**
 * Fixes the "Duplicate class kotlin.X found in kotlin-stdlib and kotlin-stdlib-jdk8"
 * error that occurs when Capacitor/plugins mix Kotlin 1.8+ (merged stdlib) with
 * older dependencies that still pull kotlin-stdlib-jdk7/jdk8 separately.
 *
 * Strategy:
 *  1. Detect the highest kotlin-stdlib version referenced in any build.gradle
 *  2. Add a subprojects resolutionStrategy to the ROOT build.gradle that forces
 *     all Kotlin stdlib artifacts to that single version
 *  3. Exclude kotlin-stdlib-jdk7/jdk8 from the app-level dependencies
 */
function patchAndroidKotlinConflicts(androidDir, log) {
  // ── 1. Detect Kotlin version in use ──────────────────────────────────────
  let kotlinVersion = '1.9.24'; // safe default — works with Java 17
  const versionCandidates = [];

  walkDir(androidDir, (filePath) => {
    if (!/build\.gradle(\.kts)?$/.test(path.basename(filePath))) return;
    try {
      const src = fs.readFileSync(filePath, 'utf8');
      // Match: kotlin_version = "1.8.22", kotlin("jvm") version "1.9.0", etc.
      const m = src.match(/kotlin[_\-]version\s*[=:]\s*["']([0-9.]+)["']/i)
                || src.match(/org\.jetbrains\.kotlin[^"']*["']([0-9.]+)["']/);
      if (m) versionCandidates.push(m[1]);
    } catch {}
  });

  if (versionCandidates.length > 0) {
    // Pick the highest version found
    kotlinVersion = versionCandidates.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0);
      }
      return 0;
    })[0];
  }

  log(`  → Kotlin stdlib: forzando versión única ${kotlinVersion}`);

  // ── 2. Patch ROOT build.gradle — add resolutionStrategy ──────────────────
  const rootGradle = path.join(androidDir, 'build.gradle');
  const rootGradleKts = path.join(androidDir, 'build.gradle.kts');
  const rootFile = fs.existsSync(rootGradle) ? rootGradle
    : fs.existsSync(rootGradleKts) ? rootGradleKts : null;

  if (rootFile) {
    let src = fs.readFileSync(rootFile, 'utf8');
    if (!src.includes('kotlin-stdlib-jdk8') && !src.includes('resolutionStrategy')) {
      // Append a subprojects block that forces consistent Kotlin stdlib
      const isKts = rootFile.endsWith('.kts');
      const block = isKts ? `
// Auto-added by Web→Native Converter: fix Kotlin stdlib duplicate class conflict
subprojects {
    configurations.all {
        resolutionStrategy {
            force("org.jetbrains.kotlin:kotlin-stdlib:${kotlinVersion}")
            force("org.jetbrains.kotlin:kotlin-stdlib-jdk7:${kotlinVersion}")
            force("org.jetbrains.kotlin:kotlin-stdlib-jdk8:${kotlinVersion}")
        }
    }
}
` : `
// Auto-added by Web→Native Converter: fix Kotlin stdlib duplicate class conflict
subprojects {
    configurations.all {
        resolutionStrategy {
            force 'org.jetbrains.kotlin:kotlin-stdlib:${kotlinVersion}'
            force 'org.jetbrains.kotlin:kotlin-stdlib-jdk7:${kotlinVersion}'
            force 'org.jetbrains.kotlin:kotlin-stdlib-jdk8:${kotlinVersion}'
        }
    }
}
`;
      fs.writeFileSync(rootFile, src + block);
      log(`  → ✅ ${path.basename(rootFile)}: resolutionStrategy kotlin stdlib añadida`);
    } else {
      log(`  → resolutionStrategy ya presente en ${path.basename(rootFile)}`);
    }
  }

  // ── 3. Patch APP build.gradle — exclude duplicate jdk modules ────────────
  const appGradle = path.join(androidDir, 'app', 'build.gradle');
  const appGradleKts = path.join(androidDir, 'app', 'build.gradle.kts');
  const appFile = fs.existsSync(appGradle) ? appGradle
    : fs.existsSync(appGradleKts) ? appGradleKts : null;

  if (appFile) {
    let src = fs.readFileSync(appFile, 'utf8');
    if (!src.includes('kotlin-stdlib-jdk8') || !src.includes('exclude')) {
      const isKts = appFile.endsWith('.kts');
      // Add configurations block to exclude old jdk artifacts
      const excludeBlock = isKts ? `
// Auto-added: exclude old Kotlin JDK stdlib artifacts (merged into kotlin-stdlib 1.8+)
configurations.all {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk7")
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk8")
}
` : `
// Auto-added: exclude old Kotlin JDK stdlib artifacts (merged into kotlin-stdlib 1.8+)
configurations.all {
    exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk7'
    exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk8'
}
`;
      // Insert after the first android { block, or just append
      const hasAndroidBlock = /^android\s*\{/m.test(src);
      if (hasAndroidBlock) {
        src = src.replace(/^(android\s*\{)/m, `${excludeBlock.trim()}\n\n$1`);
      } else {
        src = excludeBlock + src;
      }
      fs.writeFileSync(appFile, src);
      log(`  → ✅ app/build.gradle: kotlin-stdlib-jdk7/jdk8 excluidos`);
    }
  }
}

function detectJavaMajorVersion() {
  return new Promise((resolve) => {
    exec('java -version 2>&1', (err, stdout, stderr) => {
      const output = stdout + stderr;
      // Matches: version "17.0.x", version "21", version "1.8.x"
      const m = output.match(/version "(?:1\.)?(\d+)/);
      if (m) {
        resolve(parseInt(m[1]));
      } else {
        resolve(17); // safe fallback
      }
    });
  });
}

async function buildIOS(workDir, appName, appId, version, log) {
  const iosDir = path.join(workDir, 'ios', 'App');
  if (!fs.existsSync(iosDir)) throw new Error('Directorio ios/App no encontrado.');

  // Install pods
  log('  → Instalando CocoaPods...');
  await runCommand('pod', ['install', '--repo-update'], iosDir, log, 180000);

  // Build
  const archiveDir = path.join(workDir, 'ios_archive');
  log('  → Compilando con xcodebuild...');
  await runCommand('xcodebuild', [
    '-workspace', 'App.xcworkspace',
    '-scheme', 'App',
    '-configuration', 'Release',
    '-archivePath', path.join(archiveDir, 'App.xcarchive'),
    'archive',
    'CODE_SIGN_IDENTITY=""',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGNING_ALLOWED=NO'
  ], iosDir, log, 300000);

  // Export IPA
  const exportPlist = path.join(archiveDir, 'ExportOptions.plist');
  fs.writeFileSync(exportPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>development</string>
  <key>compileBitcode</key><false/>
</dict></plist>`);

  await runCommand('xcodebuild', [
    '-exportArchive',
    '-archivePath', path.join(archiveDir, 'App.xcarchive'),
    '-exportOptionsPlist', exportPlist,
    '-exportPath', archiveDir
  ], iosDir, log, 120000);
}

function findApk(workDir) {
  const patterns = [
    path.join(workDir, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    path.join(workDir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
    path.join(workDir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  ];
  return patterns.find(p => fs.existsSync(p)) || null;
}

function findIPA(workDir) {
  const archiveDir = path.join(workDir, 'ios_archive');
  if (!fs.existsSync(archiveDir)) return null;
  const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.ipa'));
  return files.length ? path.join(archiveDir, files[0]) : null;
}

function runCommand(cmd, args, cwd, log, timeout = 120000) {
  return new Promise((resolve, reject) => {
    log(`  $ ${cmd} ${args.join(' ')}`);

    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb' },
      shell: process.platform === 'win32'
    });

    activeProcess = proc;

    // Buffer to capture last N lines for error summary
    const recentLines = [];
    const MAX_RECENT = 60;
    // Collect Gradle FAILURE block lines
    const gradleErrors = [];
    let inFailureBlock = false;

    const processLine = (line, fromStderr) => {
      // Strip ANSI escape codes
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!clean) return;

      recentLines.push(clean);
      if (recentLines.length > MAX_RECENT) recentLines.shift();

      // ── Gradle error detection ──────────────────────────────────────
      // Start capturing at FAILURE: block
      if (/^FAILURE:|^> Task :|^What went wrong:|^> Could not|Execution failed for task/.test(clean)) {
        inFailureBlock = true;
      }
      if (inFailureBlock) {
        gradleErrors.push(clean);
        // Stop at BUILD FAILED line (we have enough context)
        if (/^BUILD FAILED/.test(clean)) inFailureBlock = false;
      }

      // Determine log level
      const isGradleError = /^FAILURE:|What went wrong:|Execution failed|^> Could not|^e:/.test(clean);
      const isLicenseError = /license|not been accepted/i.test(clean);
      const isImportantError = isGradleError || isLicenseError;

      // Skip pure stack trace lines from Gradle internal classes (noise)
      const isStackTrace = /^\s+at (org\.gradle|java\.|sun\.|com\.sun\.)/.test(clean);
      if (isStackTrace && !isImportantError) return;

      const level = isImportantError ? 'error'
        : fromStderr && /error:/i.test(clean) ? 'warn'
        : 'stdout';

      log(`    ${clean}`, level);
    };

    proc.stdout.on('data', (data) => {
      data.toString().split('\n').forEach(line => processLine(line, false));
    });

    proc.stderr.on('data', (data) => {
      data.toString().split('\n').forEach(line => processLine(line, true));
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout: ${cmd} tardó más de ${timeout / 1000}s`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeProcess = null;
      if (code === 0) {
        resolve();
      } else {
        // Build a clear error summary from captured error lines
        let errorSummary = `${path.basename(cmd)} terminó con código ${code}`;
        if (gradleErrors.length > 0) {
          // Find the most meaningful error line
          const meaningful = gradleErrors.find(l =>
            /What went wrong:|Execution failed|Could not resolve|Could not find|license/i.test(l)
          );
          if (meaningful) errorSummary = meaningful.replace(/^>\s*/, '').trim();
        }
        reject(new Error(errorSummary));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcess = null;
      reject(new Error(`No se pudo ejecutar "${cmd}": ${err.message}. ¿Está instalado?`));
    });
  });
}
