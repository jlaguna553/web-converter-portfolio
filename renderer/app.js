/* ═══════════════════════════════════════════════════════════════
   Web to Native Converter — Renderer
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  projectPath: null,
  outputPath: null,
  projectInfo: null,
  isConverting: false,
  autoScroll: true,
  logCount: 0,
  removeListener: null
};

// ── DOM Refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const btnBrowseProject = $('btn-browse-project');
const btnBrowseOutput  = $('btn-browse-output');
const btnCheckReqs     = $('btn-check-reqs');
const btnConvert       = $('btn-convert');
const btnConvertText   = $('btn-convert-text');
const btnCancel        = $('btn-cancel');
const btnClearLogs     = $('btn-clear-logs');
const btnAutoScroll    = $('btn-auto-scroll');
const projectPathDisplay = $('project-path-display');
const outputPathDisplay  = $('output-path-display');
const dropZone         = $('project-drop-zone');
const projectInfo      = $('project-info');
const projectBadge     = $('project-badge');
const projectWarnings  = $('project-warnings');
const projectErrors    = $('project-errors');
const infoFramework    = $('info-framework');
const infoBuild        = $('info-build');
const infoPkg          = $('info-pkg');
const requirementsList = $('requirements-list');
const progressBar      = $('progress-bar');
const progressPct      = $('progress-pct');
const progressLabel    = $('progress-label');
const progressStepText = $('progress-step-text');
const statusCard       = $('status-card');
const statusIcon       = $('status-icon');
const statusTitle      = $('status-title');
const statusSubtitle   = $('status-subtitle');
const logTerminal      = $('log-terminal');
const outputSection    = $('output-files-section');
const outputFilesList  = $('output-files-list');
const osBadge          = $('os-badge');

// ── Timeline steps ────────────────────────────────────────────────────────────
const TIMELINE_STEPS = [
  { key: 'copy',        label: 'Copiar proyecto',        keywords: ['Copiando proyecto'] },
  { key: 'install-deps', label: 'Instalar dependencias', keywords: ['npm install', 'Instalando dependencias'] },
  { key: 'build-web',   label: 'Build web',              keywords: ['npm run build', 'Compilando proyecto'] },
  { key: 'cap-install', label: 'Instalar Capacitor',     keywords: ['Instalando Capacitor'] },
  { key: 'cap-init',    label: 'Inicializar Capacitor',  keywords: ['Inicializando Capacitor'] },
  { key: 'add-platform', label: 'Agregar plataforma',    keywords: ['Agregando plataforma'] },
  { key: 'sync',        label: 'Sincronizar assets',     keywords: ['Sincronizando'] },
  { key: 'build-native', label: 'Compilar APK/IPA',      keywords: ['Compilando APK', 'Compilando IPA'] }
];

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  const platform = await window.api.getPlatform();
  const labels = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  osBadge.textContent = labels[platform] || platform;

  // iOS option — warn if not macOS
  if (platform !== 'darwin') {
    const iosOpt = $('opt-ios');
    if (iosOpt) {
      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:9px;color:#f59e0b;';
      hint.textContent = 'Solo macOS';
      iosOpt.querySelector('.platform-card').appendChild(hint);
    }
  }

  // Restore output path to Downloads if available
  const homeDir = getHomeDir();
  if (homeDir) {
    setOutputPath(homeDir + (platform === 'win32' ? '\\Downloads' : '/Downloads'));
  }

  setupEventListeners();
  validateForm();
})();

function getHomeDir() {
  // We can't access process directly, but we try via a simple heuristic
  try {
    return null; // Will be set via OS detection
  } catch { return null; }
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  // Browse project
  btnBrowseProject.addEventListener('click', async () => {
    const folder = await window.api.selectFolder();
    if (folder) await setProjectPath(folder);
  });

  // Browse output
  btnBrowseOutput.addEventListener('click', async () => {
    const folder = await window.api.selectOutputFolder();
    if (folder) setOutputPath(folder);
  });

  // Check requirements
  btnCheckReqs.addEventListener('click', checkRequirements);

  // Convert
  btnConvert.addEventListener('click', startConversion);

  // Cancel
  btnCancel.addEventListener('click', cancelConversion);

  // Clear logs
  btnClearLogs.addEventListener('click', () => {
    logTerminal.innerHTML = '<div class="log-line info"><span class="log-msg">— Logs limpiados —</span></div>';
    state.logCount = 0;
  });

  // Auto-scroll toggle
  btnAutoScroll.addEventListener('click', () => {
    state.autoScroll = !state.autoScroll;
    btnAutoScroll.classList.toggle('active', state.autoScroll);
    btnAutoScroll.textContent = state.autoScroll ? '↓ Auto' : '↓ Manual';
  });

  // Drag and drop
  setupDragDrop();

  // Platform change
  document.querySelectorAll('input[name="platform"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const p = getSelectedPlatform();
      updateTimelineForPlatform(p);
    });
  });

  // App name → auto-update app ID
  $('app-name').addEventListener('input', (e) => {
    const appId = $('app-id');
    if (!appId._userEdited) {
      const sanitized = e.target.value.toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .substring(0, 20);
      appId.value = `com.example.${sanitized || 'myapp'}`;
    }
  });

  $('app-id').addEventListener('input', () => {
    $('app-id')._userEdited = true;
  });

  // Form validation on input
  ['app-name', 'app-id', 'app-version'].forEach(id => {
    $(id).addEventListener('input', validateForm);
  });
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────
function setupDragDrop() {
  const body = document.body;

  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drag-over');
  });

  body.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      dropZone.classList.remove('drag-over');
    }
  });

  body.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');

    const items = e.dataTransfer.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry && entry.isDirectory) {
          // Get path from file
          const file = items[i].getAsFile();
          if (file && file.path) {
            await setProjectPath(file.path);
            return;
          }
        }
      }
    }
    // Fallback: file path
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].path) {
      await setProjectPath(files[0].path);
    }
  });

  dropZone.addEventListener('click', async () => {
    const folder = await window.api.selectFolder();
    if (folder) await setProjectPath(folder);
  });
}

// ── Project Path ──────────────────────────────────────────────────────────────
async function setProjectPath(folderPath) {
  state.projectPath = folderPath;
  projectPathDisplay.textContent = folderPath;
  projectPathDisplay.classList.add('has-value');
  projectPathDisplay.title = folderPath;

  // Show loading badge
  projectBadge.textContent = 'Analizando...';
  projectBadge.className = 'badge badge-warn';
  projectInfo.classList.add('hidden');

  try {
    const info = await window.api.analyzeProject(folderPath);
    state.projectInfo = info;
    renderProjectInfo(info);
    validateForm();
  } catch (e) {
    projectBadge.textContent = 'Error';
    projectBadge.className = 'badge badge-error';
    addLog(`Error al analizar proyecto: ${e.message}`, 'error');
  }
}

function setOutputPath(folderPath) {
  state.outputPath = folderPath;
  outputPathDisplay.textContent = folderPath;
  outputPathDisplay.classList.add('has-value');
  outputPathDisplay.title = folderPath;
  validateForm();
}

// ── Project Info Rendering ────────────────────────────────────────────────────
function renderProjectInfo(info) {
  // Framework labels
  const fwLabels = {
    'react': 'React', 'react-cra': 'React (CRA)',
    'vue': 'Vue', 'angular': 'Angular', 'svelte': 'Svelte',
    'next': 'Next.js', 'nuxt': 'Nuxt', 'gatsby': 'Gatsby', 'vite': 'Vite'
  };
  infoFramework.textContent = fwLabels[info.framework] || (info.framework !== 'unknown' ? info.framework : '—');
  infoBuild.textContent = info.hasBuildOutput
    ? `✓ ${info.buildDir || '.'}`
    : (info.buildDir ? `⏳ ${info.buildDir}/ (pendiente)` : 'No detectado');
  infoPkg.textContent = info.hasPackageJson ? '✓' : '✗';

  // Warnings
  projectWarnings.innerHTML = '';
  if (info.warnings.length > 0) {
    projectWarnings.classList.remove('hidden');
    info.warnings.forEach(w => {
      const el = document.createElement('div');
      el.className = 'warning-item';
      el.textContent = '⚠ ' + w;
      projectWarnings.appendChild(el);
    });
  } else {
    projectWarnings.classList.add('hidden');
  }

  // Errors
  projectErrors.innerHTML = '';
  if (info.errors.length > 0) {
    projectErrors.classList.remove('hidden');
    info.errors.forEach(e => {
      const el = document.createElement('div');
      el.className = 'error-item';
      el.textContent = '✗ ' + e;
      projectErrors.appendChild(el);
    });
  } else {
    projectErrors.classList.add('hidden');
  }

  projectInfo.classList.remove('hidden');

  if (!info.valid) {
    projectBadge.textContent = 'Inválido';
    projectBadge.className = 'badge badge-error';
  } else if (info.warnings.length > 0) {
    projectBadge.textContent = 'Advertencias';
    projectBadge.className = 'badge badge-warn';
  } else {
    projectBadge.textContent = 'Válido';
    projectBadge.className = 'badge badge-ok';
  }
}

// ── Requirements Check ────────────────────────────────────────────────────────
async function checkRequirements() {
  const platform = getSelectedPlatform();
  btnCheckReqs.disabled = true;
  btnCheckReqs.textContent = '...';
  requirementsList.innerHTML = '<p class="req-hint">Verificando...</p>';

  try {
    const checks = await window.api.checkRequirements(platform);
    renderRequirements(checks);
  } catch (e) {
    requirementsList.innerHTML = `<p class="req-hint" style="color:var(--red)">Error: ${e.message}</p>`;
  } finally {
    btnCheckReqs.disabled = false;
    btnCheckReqs.textContent = 'Verificar';
  }
}

function renderRequirements(checks) {
  requirementsList.innerHTML = '';
  checks.forEach(check => {
    const item = document.createElement('div');
    item.className = 'req-item';

    let iconClass = check.installed ? 'ok' : (check.warning ? 'warn' : 'fail');
    let iconText = check.installed ? '✓' : (check.warning ? '!' : '✗');

    item.innerHTML = `
      <div class="req-icon ${iconClass}">${iconText}</div>
      <span class="req-name">${check.name}</span>
      <span class="req-version">${check.version ? truncate(check.version, 30) : (check.warning || 'No encontrado')}</span>
    `;
    requirementsList.appendChild(item);
  });
}

// ── Form Validation ───────────────────────────────────────────────────────────
function validateForm() {
  const hasProject = !!state.projectPath && state.projectInfo?.valid;
  const hasOutput  = !!state.outputPath;
  const hasAppName = !!$('app-name').value.trim();
  const hasAppId   = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test($('app-id').value.trim());
  const hasVersion = !!$('app-version').value.trim();

  btnConvert.disabled = !(hasProject && hasOutput && hasAppName && hasAppId && hasVersion);

  if (!hasAppId && $('app-id').value.trim()) {
    $('app-id').style.borderColor = 'var(--red)';
  } else {
    $('app-id').style.borderColor = '';
  }
}

// ── Conversion ────────────────────────────────────────────────────────────────
async function startConversion() {
  if (state.isConverting) return;
  state.isConverting = true;

  // UI: running state
  btnConvert.classList.add('hidden');
  btnCancel.classList.remove('hidden');
  outputSection.classList.add('hidden');
  outputFilesList.innerHTML = '';

  setStatus('running', '⚡', 'Convirtiendo...', 'La conversión está en progreso');
  setProgress(0, 'Iniciando conversión...');
  resetTimeline();
  clearLogs();
  addLog('🚀 Iniciando conversión del proyecto...', 'info');

  // Remove previous listener
  if (state.removeListener) {
    state.removeListener();
    state.removeListener = null;
  }

  // Listen for conversion events
  state.removeListener = window.api.onConversionEvent((event) => {
    handleConversionEvent(event);
  });

  const config = {
    projectPath: state.projectPath,
    outputPath: state.outputPath,
    appName: $('app-name').value.trim(),
    appId: $('app-id').value.trim(),
    appVersion: $('app-version').value.trim(),
    platform: getSelectedPlatform(),
    buildFirst: $('build-first').checked,
    signingMode: $('signing-mode').value
  };

  try {
    await window.api.startConversion(config);
  } catch (e) {
    // Errors are handled via events
  }
}

function handleConversionEvent({ type, data }) {
  switch (type) {
    case 'log':
      addLog(data.message, data.level || 'info');
      updateTimelineFromLog(data.message);
      break;

    case 'progress':
      setProgress(data.pct, data.message);
      updateTimelineFromProgress(data.message);
      break;

    case 'error':
      addLog('❌ ' + data.message, 'error');
      break;

    case 'output-file':
      showOutputFile(data.platform, data.path);
      break;

    case 'done':
      finishConversion(data.success, data.error);
      break;
  }
}

function finishConversion(success, errorMsg) {
  state.isConverting = false;
  btnCancel.classList.add('hidden');
  btnConvert.classList.remove('hidden');

  if (state.removeListener) {
    state.removeListener();
    state.removeListener = null;
  }

  if (success) {
    setProgress(100, '¡Conversión completada!');
    setStatus('success', '✅', '¡Conversión exitosa!', 'El archivo está listo para instalarse');
    addLog('🎉 ¡Conversión completada con éxito!', 'success');
    markAllTimelineDone();
    outputSection.classList.remove('hidden');
    outputSection.classList.add('fade-in');
  } else {
    setStatus('error', '❌', 'Conversión fallida', errorMsg || 'Revisa los logs para más detalles');
    addLog(`❌ Conversión fallida: ${errorMsg || 'Error desconocido'}`, 'error');
    markTimelineError();
  }
}

async function cancelConversion() {
  await window.api.cancelConversion();
  state.isConverting = false;
  btnCancel.classList.add('hidden');
  btnConvert.classList.remove('hidden');
  setStatus('idle', '⏹', 'Conversión cancelada', 'Puedes reintentar en cualquier momento');
  addLog('⏹ Conversión cancelada por el usuario.', 'warn');
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function setStatus(type, icon, title, subtitle) {
  statusIcon.textContent = icon;
  statusTitle.textContent = title;
  statusSubtitle.textContent = subtitle;
  statusCard.className = 'status-card';
  if (type !== 'idle') statusCard.classList.add(type);
}

function setProgress(pct, message) {
  progressBar.style.width = pct + '%';
  progressPct.textContent = pct + '%';
  if (message) progressStepText.textContent = message;
  if (pct > 0 && pct < 100) {
    progressBar.classList.add('running');
  } else {
    progressBar.classList.remove('running');
  }
}

function clearLogs() {
  logTerminal.innerHTML = '';
  state.logCount = 0;
}

function addLog(message, level = 'info') {
  state.logCount++;

  // Limit log entries for performance
  if (state.logCount > 2000) {
    const first = logTerminal.querySelector('.log-line');
    if (first) first.remove();
  }

  const now = new Date();
  const time = now.toTimeString().split(' ')[0];

  const line = document.createElement('div');
  line.className = `log-line ${level} fade-in`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = time;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = message;

  line.appendChild(timeSpan);
  line.appendChild(msgSpan);
  logTerminal.appendChild(line);

  if (state.autoScroll) {
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }
}

function showOutputFile(platform, filePath) {
  const icons = { android: '📦', ios: '📱' };
  const fileName = filePath.split(/[/\\]/).pop();

  const item = document.createElement('div');
  item.className = 'output-file-item fade-in';
  item.innerHTML = `
    <span class="output-file-icon">${icons[platform] || '📄'}</span>
    <div class="output-file-info">
      <div class="output-file-name">${fileName}</div>
      <div class="output-file-path">${filePath}</div>
    </div>
    <button class="btn btn-ghost btn-sm" onclick="window.api.openFolder('${escapeAttr(filePath.replace(/[/\\][^/\\]+$/, ''))}')">
      Abrir
    </button>
  `;
  outputFilesList.appendChild(item);
}

// ── Timeline ──────────────────────────────────────────────────────────────────
function resetTimeline() {
  document.querySelectorAll('.timeline-item').forEach(el => {
    el.className = 'timeline-item pending';
  });
}

function updateTimelineFromLog(msg) {
  const stepMap = [
    { key: 'copy',        match: /Copiando proyecto/i },
    { key: 'install-deps', match: /npm install|Instalando dependencias/i },
    { key: 'build-web',   match: /npm run build|Compilando proyecto web/i },
    { key: 'cap-install', match: /Instalando Capacitor|@capacitor\/core/i },
    { key: 'cap-init',    match: /Inicializando Capacitor|capacitor\.config/i },
    { key: 'add-platform', match: /Agregando plataforma|cap add/i },
    { key: 'sync',        match: /Sincronizando|cap sync/i },
    { key: 'build-native', match: /Compilando APK|Compilando IPA|gradle|xcodebuild/i }
  ];

  stepMap.forEach(({ key, match }) => {
    if (match.test(msg)) {
      const el = document.querySelector(`[data-step="${key}"]`);
      if (el && el.classList.contains('pending')) {
        el.className = 'timeline-item active';
      }
    }
  });

  // Mark completed when next step starts
  if (/✅/.test(msg)) {
    const active = document.querySelector('.timeline-item.active');
    if (active) {
      active.className = 'timeline-item done';
      const next = active.nextElementSibling;
      if (next && next.classList.contains('pending')) {
        // Don't auto-activate, wait for the next step's keyword
      }
    }
  }
}

function updateTimelineFromProgress(message) {
  // Map progress messages to timeline steps
  const map = {
    'Copiando': 'copy',
    'dependencias': 'install-deps',
    'Build web': 'build-web',
    'Capacitor': 'cap-install',
    'Inicializando Capacitor': 'cap-init',
    'plataforma': 'add-platform',
    'Sincronizando': 'sync',
    'APK': 'build-native',
    'IPA': 'build-native'
  };

  for (const [keyword, step] of Object.entries(map)) {
    if (message.includes(keyword)) {
      activateTimelineStep(step);
      break;
    }
  }
}

function activateTimelineStep(key) {
  const el = document.querySelector(`[data-step="${key}"]`);
  if (!el) return;

  // Mark previous steps as done
  let prev = el.previousElementSibling;
  while (prev) {
    if (prev.classList.contains('active') || prev.classList.contains('pending')) {
      prev.className = 'timeline-item done';
    }
    prev = prev.previousElementSibling;
  }

  el.className = 'timeline-item active';
}

function markAllTimelineDone() {
  document.querySelectorAll('.timeline-item').forEach(el => {
    el.className = 'timeline-item done';
  });
}

function markTimelineError() {
  const active = document.querySelector('.timeline-item.active');
  if (active) active.className = 'timeline-item error';
}

function updateTimelineForPlatform(platform) {
  // No-op for now — UI adjusts based on conversion events
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function getSelectedPlatform() {
  const radio = document.querySelector('input[name="platform"]:checked');
  return radio ? radio.value : 'android';
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'");
}
