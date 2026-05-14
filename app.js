const APP_CONFIG = {
  appsScriptUrl: window.SPMS_CONFIG?.appsScriptUrl || "",
  premiseId: "STRIDE_BA",
  premiseName: "Kompleks STRIDE Batu Arang",
  accuracyLimitMeter: 15
};

const seed = {
  users: [
    { user_id: "G001", name: "Guard 1", role: "Guard", pin: "1234", status: "ACTIVE", created_at: "2026-05-13" },
    { user_id: "A001", name: "Admin 1", role: "Admin", pin: "1234", status: "ACTIVE", created_at: "2026-05-13" },
    { user_id: "S001", name: "Supervisor 1", role: "Supervisor", pin: "1234", status: "ACTIVE", created_at: "2026-05-13" }
  ],
  checkpoints: [],
  shifts: [
    { shift_id: "DAY", shift_name: "Shift Siang", start_time: "08:00", end_time: "20:00", patrol_interval_hour: 1, tolerance_minute: 15, status: "ACTIVE" },
    { shift_id: "NIGHT", shift_name: "Shift Malam", start_time: "20:00", end_time: "08:00", patrol_interval_hour: 1, tolerance_minute: 15, status: "ACTIVE" }
  ],
  patrol_logs: []
};

const store = {
  get(key) {
    const value = localStorage.getItem(`spms_${key}`);
    if (value) return JSON.parse(value);
    localStorage.setItem(`spms_${key}`, JSON.stringify(seed[key]));
    return structuredClone(seed[key]);
  },
  set(key, value) {
    localStorage.setItem(`spms_${key}`, JSON.stringify(value));
  },
  user() {
    const raw = sessionStorage.getItem("spms_session");
    return raw ? JSON.parse(raw) : null;
  },
  setUser(user) {
    sessionStorage.setItem("spms_session", JSON.stringify(user));
  },
  clearUser() {
    sessionStorage.removeItem("spms_session");
  }
};

function migrateLocalData() {
  const version = localStorage.getItem("spms_data_version");
  if (version !== "2" && version !== "3") {
    localStorage.removeItem("spms_checkpoints");
    localStorage.removeItem("spms_patrol_logs");
  }
  if (version !== "3") {
    localStorage.setItem("spms_shifts", JSON.stringify(seed.shifts));
  }
  localStorage.setItem("spms_data_version", "3");
}

migrateLocalData();

const state = {
  route: "scan",
  scanner: null,
  selectedQr: "CP001",
  syncDone: false,
  scanLocked: false
};

const app = document.getElementById("app");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function nowParts() {
  const now = new Date();
  return {
    phone_timestamp: now.toISOString(),
    phone_date: now.toLocaleDateString("ms-MY"),
    phone_time: now.toLocaleTimeString("ms-MY", { hour12: false })
  };
}

function qrTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}

function tickClock() {
  const clock = document.querySelector("[data-clock]");
  if (clock) {
    clock.textContent = new Date().toLocaleTimeString("ms-MY", { hour12: false });
  }
}

setInterval(tickClock, 1000);

function statusPill(value) {
  const kind = value === "VALID" || value === "GOOD" ? "good" : value === "LOW_ACCURACY" || value === "OUT_OF_RANGE" || value === "NO_CP_COORD" ? "warn" : "bad";
  return `<span class="pill ${kind}">${escapeHtml(value)}</span>`;
}

function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => deg * Math.PI / 180;
  const radius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getAccuracyStatus(accuracy) {
  if (accuracy === null || accuracy === undefined || Number.isNaN(Number(accuracy))) return "GPS_FAILED";
  return Number(accuracy) <= APP_CONFIG.accuracyLimitMeter ? "VALID" : "LOW_ACCURACY";
}

function minutesFromTime(value) {
  const normalized = normalizeTime(value);
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeTime(value) {
  const text = String(value || "");
  const match = text.match(/\b(\d{2}):(\d{2})\b/);
  if (match) return `${match[1]}:${match[2]}`;
  return "00:00";
}

function isTimeWithinRange(current, start, end) {
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function currentShiftStatus(date = new Date()) {
  const shifts = store.get("shifts").filter((shift) => shift.status === "ACTIVE");
  const current = date.getHours() * 60 + date.getMinutes();
  const shift = shifts.find((item) => isTimeWithinRange(current, minutesFromTime(item.start_time), minutesFromTime(item.end_time)));

  if (!shift) {
    return { shift_id: "", shift_name: "", patrol_status: "NO_ACTIVE_SHIFT", patrol_time: "" };
  }

  const tolerance = Number(shift.tolerance_minute || 0);
  const intervalMinute = Number(shift.patrol_interval_hour || 1) * 60;
  const start = minutesFromTime(shift.start_time);
  const end = minutesFromTime(shift.end_time);
  const currentNormalized = current < start && start > end ? current + 1440 : current;
  const endNormalized = end <= start ? end + 1440 : end;
  const elapsed = currentNormalized - start;
  const currentCycle = Math.max(0, Math.floor(elapsed / intervalMinute));
  const windowStart = start + currentCycle * intervalMinute;
  const windowEnd = Math.min(windowStart + intervalMinute, endNormalized);
  const inPatrolWindow = currentNormalized >= windowStart && currentNormalized <= windowEnd;
  const nextWindowStart = windowStart >= 1440 ? windowStart - 1440 : windowStart;
  const nextWindowEnd = windowEnd >= 1440 ? windowEnd - 1440 : windowEnd;
  const windowLabel = `${String(Math.floor(nextWindowStart / 60)).padStart(2, "0")}:${String(nextWindowStart % 60).padStart(2, "0")}-${String(Math.floor(nextWindowEnd / 60)).padStart(2, "0")}:${String(nextWindowEnd % 60).padStart(2, "0")}`;

  return {
    shift_id: shift.shift_id,
    shift_name: shift.shift_name,
    patrol_status: inPatrolWindow ? "IN_PATROL_WINDOW" : "OUT_OF_PATROL_WINDOW",
    patrol_time: windowLabel
  };
}

async function apiPost(action, payload) {
  if (!APP_CONFIG.appsScriptUrl) return { ok: true, localOnly: true };
  const response = await fetch(APP_CONFIG.appsScriptUrl, {
    method: "POST",
    body: JSON.stringify({ action, payload }),
    headers: { "Content-Type": "text/plain;charset=utf-8" }
  });
  return response.json();
}

async function syncFromApi() {
  if (!APP_CONFIG.appsScriptUrl) return;
  const response = await fetch(APP_CONFIG.appsScriptUrl);
  const data = await response.json();
  if (!data.ok) return;

  ["users", "checkpoints", "shifts", "patrol_logs"].forEach((key) => {
    if (Array.isArray(data[key])) {
      store.set(key, data[key]);
    }
  });
}

function layout(content) {
  const user = store.user();
  if (!user) {
    app.innerHTML = content;
    return;
  }

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <img src="assets/logo_stride.png" alt="STRIDE">
          <div class="brand-title">
            <strong>Security Patrol Monitoring System</strong>
            <span>${escapeHtml(APP_CONFIG.premiseName)} | ${escapeHtml(user.name)} (${escapeHtml(user.role)})</span>
          </div>
        </div>
        <div class="clock" data-clock></div>
      </header>
      <main class="page">${content}</main>
    </div>
  `;
  tickClock();
}

function renderLogin(message = "") {
  store.clearUser();
  app.innerHTML = `
    <section class="login-page">
      <div class="login-intro">
        <div>
          <h1>Security Patrol Monitoring System</h1>
          <p>Guard scan checkpoint menggunakan handphone. Admin jana QR dan report. Supervisor pantau rondaan harian.</p>
        </div>
      </div>
      <div class="login-panel">
        <form class="login-card" id="loginForm">
          <img class="login-logo" src="assets/logo_stride.png" alt="STRIDE">
          <h2>Login</h2>
          <p class="muted">Demo ID: G001, A001, S001. PIN: 1234</p>
          ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ""}
          <div class="form-grid">
            <label>ID Pengguna<input name="user_id" autocomplete="username" required></label>
            <label>PIN<input name="pin" type="password" autocomplete="current-password" required></label>
            <button class="btn" type="submit">Login</button>
          </div>
        </form>
      </div>
    </section>
  `;

  document.getElementById("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const users = store.get("users");
    const user = users.find((item) =>
      item.user_id.toUpperCase() === String(form.get("user_id")).trim().toUpperCase() &&
      item.pin === String(form.get("pin")).trim() &&
      item.status === "ACTIVE"
    );

    if (!user) {
      renderLogin("ID atau PIN tidak sah, atau akaun tidak aktif.");
      return;
    }

    store.setUser({ user_id: user.user_id, name: user.name, role: user.role });
    state.route = user.role === "Guard" ? "scan" : "monitor";
    renderApp();
  });
}

function navTabs(user) {
  const tabs = allowedTabs(user);
  return `
    <div class="toolbar">
      <div class="tabs">
        ${tabs.map(([route, label]) => `<button class="tab ${state.route === route ? "active" : ""}" data-route="${route}">${label}</button>`).join("")}
      </div>
      <button class="btn secondary" data-action="logout">Logout</button>
    </div>
  `;
}

function allowedTabs(user) {
  const tabs = [];
  if (user.role === "Guard") tabs.push(["scan", "Scan CP"]);
  if (user.role === "Admin" || user.role === "Supervisor") {
    if (user.role === "Supervisor") tabs.push(["monitor", "Monitor"]);
    tabs.push(["users", "ID"]);
    tabs.push(["checkpoints", "Checkpoint"]);
    tabs.push(["shifts", "Shift"]);
    tabs.push(["qr", "QR Code"]);
    tabs.push(["reports", "Report"]);
  }
  if (user.role === "Admin") tabs.unshift(["monitor", "Ringkasan"]);
  return tabs;
}

function bindShellActions() {
  document.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", async () => {
      stopScanner();
      state.route = button.dataset.route;
      if (["qr", "checkpoints", "reports", "monitor"].includes(state.route)) {
        try {
          await syncFromApi();
        } catch (error) {
          console.warn("Google Sheet sync failed", error);
        }
      }
      renderApp();
    });
  });
  document.querySelector("[data-action='logout']")?.addEventListener("click", () => {
    stopScanner();
    renderLogin();
  });
}

async function renderApp() {
  const user = store.user();
  if (!user) {
    renderLogin();
    return;
  }

  if (!state.syncDone) {
    state.syncDone = true;
    try {
      await syncFromApi();
    } catch (error) {
      console.warn("Google Sheet sync failed", error);
    }
  }

  const tabs = allowedTabs(user);
  if (!tabs.some(([route]) => route === state.route)) {
    state.route = tabs[0][0];
  }

  let view = "";
  if (state.route === "scan") view = renderScanView(user);
  if (state.route === "monitor") view = renderMonitorView(user);
  if (state.route === "users") view = renderUsersView();
  if (state.route === "checkpoints") view = renderCheckpointsView();
  if (state.route === "shifts") view = renderShiftsView();
  if (state.route === "qr") view = renderQrView();
  if (state.route === "reports") view = renderReportsView();

  layout(navTabs(user) + view);
  bindShellActions();
  bindView();
}

function renderScanView(user) {
  return `
    <section class="grid two">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Scan Checkpoint</h2>
            <p class="muted">GPS accuracy mesti 15m ke bawah untuk status VALID.</p>
          </div>
        </div>
        <div class="scanner-box"><div id="reader"></div></div>
        <div class="form-grid">
          <button class="btn" data-action="startScan">Buka Kamera</button>
          <label>Scan QR Dari Gambar
            <input id="qrImageInput" type="file" accept="image/*">
          </label>
          <label>Manual QR / CP Code<input id="manualQr" placeholder="STRIDE_BA_CP001"></label>
          <button class="btn secondary" data-action="manualScan">Submit Manual</button>
        </div>
      </div>
      <div class="panel">
        <h3>Status Scan</h3>
        <div id="scanResult" class="notice" style="margin-top:14px;">Belum ada scan untuk sesi ini.</div>
        <div style="margin-top:16px;">
          ${renderRecentLogs(user.user_id)}
        </div>
      </div>
    </section>
  `;
}

function renderRecentLogs(userId = "") {
  const logs = store.get("patrol_logs")
    .filter((log) => !userId || log.user_id === userId)
    .slice()
    .reverse()
    .slice(0, 8);

  if (!logs.length) return `<p class="muted">Tiada log lagi.</p>`;

  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Masa</th><th>CP</th><th>Accuracy</th><th>Status</th></tr></thead>
        <tbody>
          ${logs.map((log) => `
            <tr>
              <td>${escapeHtml(new Date(log.phone_timestamp).toLocaleString("ms-MY"))}</td>
              <td>${escapeHtml(log.checkpoint_id)}</td>
              <td>${escapeHtml(log.accuracy_meter)}m</td>
              <td>${statusPill(log.scan_status)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Browser tidak support GPS."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    });
  });
}

async function getBestPosition(options = {}) {
  const targetAccuracy = options.targetAccuracy ?? APP_CONFIG.accuracyLimitMeter;
  const timeoutMs = options.timeoutMs ?? 30000;
  const minReadings = options.minReadings ?? 3;
  const onUpdate = options.onUpdate || (() => {});
  const started = Date.now();
  let best = null;
  let readings = 0;
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const position = await getCurrentPosition();
      readings += 1;
      const accuracy = Number(position.coords.accuracy);
      if (!best || accuracy < Number(best.coords.accuracy)) {
        best = position;
      }

      const remaining = Math.max(0, Math.ceil((timeoutMs - (Date.now() - started)) / 1000));
      onUpdate({
        accuracy: Math.round(accuracy),
        bestAccuracy: Math.round(Number(best.coords.accuracy)),
        readings,
        remaining
      });

      if (readings >= minReadings && Number(best.coords.accuracy) <= targetAccuracy) {
        return best;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  if (best) return best;
  throw lastError || new Error("GPS gagal dikesan.");
}

async function handleCheckpointScan(qrValue) {
  const user = store.user();
  const checkpoints = store.get("checkpoints");
  const checkpoint = checkpoints.find((item) => item.qr_value === qrValue || item.checkpoint_id === qrValue);
  const output = document.getElementById("scanResult");

  if (!checkpoint) {
    output.innerHTML = `<span class="pill bad">INVALID_QR</span><p>QR tidak sepadan dengan checkpoint aktif.</p>`;
    return;
  }

  output.innerHTML = `<span class="pill warn">GPS_LOADING</span><p>Sedang stabilkan GPS...</p>`;

  let position;
  try {
    position = await getBestPosition({
      onUpdate: ({ accuracy, bestAccuracy, readings, remaining }) => {
        output.innerHTML = `
          <span class="pill warn">GPS_LOADING</span>
          <p>Sedang stabilkan GPS...<br>Bacaan: ${readings}<br>Accuracy sekarang: ${accuracy}m<br>Best accuracy: ${bestAccuracy}m<br>Baki: ${remaining}s</p>
        `;
      }
    });
  } catch (error) {
    await saveScanLog(user, checkpoint, null, "GPS_FAILED", "GPS_FAILED");
    output.innerHTML = `<span class="pill bad">GPS_FAILED</span><p>${escapeHtml(error.message || "GPS gagal dikesan.")}</p>`;
    return;
  }

  const lat = Number(position.coords.latitude);
  const lng = Number(position.coords.longitude);
  const accuracy = Math.round(Number(position.coords.accuracy));
  const accuracyStatus = getAccuracyStatus(accuracy);
  const hasCpCoord = checkpoint.lat !== "" && checkpoint.lng !== "";
  const distance = hasCpCoord ? Math.round(haversine(lat, lng, Number(checkpoint.lat), Number(checkpoint.lng))) : "";
  let scanStatus = accuracyStatus;

  if (scanStatus === "VALID" && hasCpCoord && distance > Number(checkpoint.radius_meter)) {
    scanStatus = "OUT_OF_RANGE";
  }
  if (scanStatus === "VALID" && !hasCpCoord) {
    scanStatus = "NO_CP_COORD";
  }

  const shiftStatus = currentShiftStatus();
  if (scanStatus === "VALID" && shiftStatus.patrol_status !== "IN_PATROL_TIME") {
    scanStatus = shiftStatus.patrol_status;
  }

  await saveScanLog(user, checkpoint, { lat, lng, accuracy, distance }, accuracyStatus, scanStatus, shiftStatus);
  output.innerHTML = `
    <div class="status-line">${statusPill(scanStatus)} ${statusPill(accuracyStatus)}</div>
    <p><strong>${escapeHtml(checkpoint.checkpoint_id)} - ${escapeHtml(checkpoint.name)}</strong></p>
    <p>Lat/Lng: ${lat.toFixed(6)}, ${lng.toFixed(6)}<br>Accuracy: ${accuracy}m<br>Distance: ${distance === "" ? "CP coordinate belum set" : `${distance}m`}<br>Shift: ${escapeHtml(shiftStatus.shift_name || "-")} (${escapeHtml(shiftStatus.patrol_status)})</p>
  `;
}

async function decodeQrFromImageFile(file) {
  if ("BarcodeDetector" in window) {
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const bitmap = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      if (results.length && results[0].rawValue) return results[0].rawValue;
    } catch (error) {
      console.warn("BarcodeDetector failed", error);
    }
  }

  const image = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

  if (window.jsQR) {
    const result = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth"
    });
    if (result?.data) return result.data;
  }

  if (window.Html5Qrcode) {
    const scannerOptions = window.Html5QrcodeSupportedFormats
      ? { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false }
      : { verbose: false };
    const fileScanner = new Html5Qrcode("reader", scannerOptions);
    try {
      return await fileScanner.scanFile(file, true);
    } finally {
      fileScanner.clear().catch(() => {});
    }
  }

  throw new Error("QR_NOT_DETECTED");
}

async function saveScanLog(user, checkpoint, gps, accuracyStatus, scanStatus, shiftStatus = currentShiftStatus()) {
  const parts = nowParts();
  const logs = store.get("patrol_logs");
  const log = {
    log_id: `LOG${String(Date.now()).slice(-10)}`,
    user_id: user.user_id,
    user_name: user.name,
    checkpoint_id: checkpoint.checkpoint_id,
    checkpoint_name: checkpoint.name,
    phone_timestamp: parts.phone_timestamp,
    phone_date: parts.phone_date,
    phone_time: parts.phone_time,
    server_timestamp: new Date().toISOString(),
    lat: gps ? gps.lat.toFixed(6) : "",
    lng: gps ? gps.lng.toFixed(6) : "",
    accuracy_meter: gps ? gps.accuracy : "",
    accuracy_status: accuracyStatus,
    distance_meter: gps ? gps.distance : "",
    shift_id: shiftStatus.shift_id,
    shift_name: shiftStatus.shift_name,
    patrol_time: shiftStatus.patrol_time,
    patrol_status: shiftStatus.patrol_status,
    scan_status: scanStatus,
    note: ""
  };
  logs.push(log);
  store.set("patrol_logs", logs);
  await apiPost("savePatrolLog", log);
}

function stopScanner() {
  if (state.scanner) {
    state.scanner.stop().catch(() => {});
    state.scanner = null;
  }
  state.scanLocked = false;
}

function renderMonitorView() {
  const checkpoints = store.get("checkpoints");
  const logs = store.get("patrol_logs");
  const today = new Date().toLocaleDateString("ms-MY");
  const todayLogs = logs.filter((log) => log.phone_date === today);
  const scanned = new Set(todayLogs.map((log) => log.checkpoint_id));
  const low = todayLogs.filter((log) => log.scan_status !== "VALID").length;

  return `
    <section class="grid three">
      <div class="metric"><span>Checkpoint Hari Ini</span><strong>${scanned.size}/${checkpoints.length}</strong></div>
      <div class="metric"><span>Jumlah Scan</span><strong>${todayLogs.length}</strong></div>
      <div class="metric"><span>Perlu Semak</span><strong>${low}</strong></div>
    </section>
    <section class="panel" style="margin-top:16px;">
      <div class="panel-head">
        <div>
          <h2>Monitor Rondaan</h2>
          <p class="muted">Status berdasarkan log yang tersimpan dalam browser ini. Bila Apps Script disambung, data akan datang dari Google Sheet.</p>
        </div>
      </div>
      ${renderLogsTable(todayLogs.slice().reverse())}
    </section>
  `;
}

function renderUsersView() {
  const users = store.get("users");
  return `
    <section class="grid two">
      <form class="panel" id="userForm">
        <h2>Daftar ID</h2>
        <div class="form-grid">
          <label>ID<input name="user_id" placeholder="G002" required></label>
          <label>Nama<input name="name" required></label>
          <label>Category
            <select name="role">
              <option>Guard</option>
              <option>Admin</option>
              <option>Supervisor</option>
            </select>
          </label>
          <label>PIN<input name="pin" value="1234" required></label>
          <button class="btn" type="submit">Simpan ID</button>
        </div>
      </form>
      <div class="panel">
        <h2>Senarai ID</h2>
        <div class="table-wrap" style="margin-top:14px;">
          <table>
            <thead><tr><th>ID</th><th>Nama</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              ${users.map((user) => `<tr><td>${escapeHtml(user.user_id)}</td><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.role)}</td><td>${escapeHtml(user.status)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderCheckpointsView() {
  const checkpoints = store.get("checkpoints");
  const rows = checkpoints.length ? checkpoints.map((cp) => `
                <tr>
                  <td>${escapeHtml(cp.checkpoint_id)}</td>
                  <td><input data-cp-name="${escapeHtml(cp.checkpoint_id)}" value="${escapeHtml(cp.name)}"></td>
                  <td>${escapeHtml(cp.qr_value)}</td>
                  <td>${cp.lat && cp.lng ? `${escapeHtml(cp.lat)}, ${escapeHtml(cp.lng)}` : "<span class='muted'>Belum set</span>"}</td>
                  <td><input data-cp-radius="${escapeHtml(cp.checkpoint_id)}" type="number" min="1" value="${escapeHtml(cp.radius_meter)}"></td>
                  <td>
                    <button class="btn secondary" data-action="setCpGps" data-cp="${escapeHtml(cp.checkpoint_id)}">Set GPS</button>
                    <button class="btn secondary" data-action="saveCp" data-cp="${escapeHtml(cp.checkpoint_id)}">Simpan</button>
                  </td>
                </tr>
              `).join("") : `
                <tr>
                  <td colspan="6"><span class="muted">Belum ada CP didaftarkan.</span></td>
                </tr>
              `;
  return `
    <section class="grid two">
      <form class="panel" id="cpRegisterForm">
        <h2>Register CP</h2>
        <p class="muted">Masukkan nombor CP dan nama kawasan. QR value akan dijana automatik.</p>
        <div class="form-grid">
          <label>CP No
            <input name="cp_no" inputmode="numeric" placeholder="1" min="1" max="999" required>
          </label>
          <label>Nama Kawasan
            <input name="name" placeholder="Pintu Utama" required>
          </label>
          <div class="grid two" style="gap:10px;">
            <label>Latitude
              <input name="lat" id="registerLat" placeholder="3.xxxxxx">
            </label>
            <label>Longitude
              <input name="lng" id="registerLng" placeholder="101.xxxxxx">
            </label>
          </div>
          <button class="btn secondary" type="button" data-action="getRegisterGps">Ambil GPS Location</button>
          <div id="registerGpsStatus" class="muted"></div>
          <label>Radius Meter
            <input name="radius_meter" type="number" min="1" value="50" required>
          </label>
          <button class="btn" type="submit">Register CP</button>
        </div>
        <div class="notice" style="margin-top:14px;">Contoh CP No 1 akan jadi CP001 dan QR value STRIDE_BA_CP001_timestamp. Timestamp dijana masa register dan kekal untuk CP itu.</div>
      </form>
      <div class="panel">
        <h2>Senarai CP</h2>
        <p class="muted">Set coordinate bila berada di lokasi sebenar CP.</p>
        <div class="table-wrap" style="margin-top:14px;">
          <table>
            <thead><tr><th>CP</th><th>Nama</th><th>QR Value</th><th>Coordinate</th><th>Radius</th><th>Tindakan</th></tr></thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderShiftsView() {
  const shifts = store.get("shifts");
  const day = shifts.find((shift) => shift.shift_id === "DAY") || seed.shifts[0];
  const night = shifts.find((shift) => shift.shift_id === "NIGHT") || seed.shifts[1];
  return `
    <section class="panel">
      <h2>Shift Rondaan</h2>
      <p class="muted">Tetapkan rondaan setiap berapa jam dalam tempoh Shift Siang dan Shift Malam.</p>
      <form class="grid two" id="shiftForm" style="margin-top:16px;">
        ${renderShiftEditor("DAY", "Shift Siang", day)}
        ${renderShiftEditor("NIGHT", "Shift Malam", night)}
        <button class="btn" type="submit" style="grid-column:1 / -1;">Simpan Shift</button>
      </form>
    </section>
    <section class="panel" style="margin-top:16px;">
      <h2>Senarai Shift</h2>
      <div class="table-wrap" style="margin-top:14px;">
        <table>
          <thead><tr><th>Shift</th><th>Masa</th><th>Rondaan Setiap</th></tr></thead>
          <tbody>
            ${[day, night].map((shift) => `
              <tr>
                <td>${escapeHtml(shift.shift_name)}<br><span class="muted">${escapeHtml(shift.shift_id)}</span></td>
                <td>${escapeHtml(normalizeTime(shift.start_time))} - ${escapeHtml(normalizeTime(shift.end_time))}</td>
                <td>${escapeHtml(shift.patrol_interval_hour || 1)} jam</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderShiftEditor(prefix, label, shift) {
  return `
      <div class="panel">
        <h3>${escapeHtml(label)}</h3>
        <div class="form-grid">
          <div class="grid two" style="gap:10px;">
            <label>Start Time
              <input name="${prefix}_start_time" type="time" value="${escapeHtml(normalizeTime(shift.start_time))}" required>
            </label>
            <label>End Time
              <input name="${prefix}_end_time" type="time" value="${escapeHtml(normalizeTime(shift.end_time))}" required>
            </label>
          </div>
          <label>Rondaan Setiap (Jam)
            <input name="${prefix}_patrol_interval_hour" type="number" min="1" step="1" value="${escapeHtml(shift.patrol_interval_hour || 1)}" required>
          </label>
        </div>
      </div>
  `;
}

function renderQrView() {
  const checkpoints = store.get("checkpoints");
  const selected = checkpoints.find((cp) => cp.checkpoint_id === state.selectedQr) || checkpoints[0];
  if (!selected) {
    return `
      <section class="panel">
        <h2>Generate QR Code</h2>
        <p class="muted">Belum ada checkpoint didaftarkan.</p>
        <button class="btn" data-action="refreshSheet" style="margin-top:12px;">Refresh Dari Google Sheet</button>
        <div class="notice" style="margin-top:14px;">Daftar CP dahulu dalam menu Checkpoint. Selepas register, CP akan muncul dalam dropdown QR Code.</div>
      </section>
    `;
  }
  state.selectedQr = selected.checkpoint_id;
  return `
    <section class="grid two">
      <div class="panel">
        <h2>Generate QR Code</h2>
        <p class="muted">Senarai dropdown diambil daripada CP yang didaftarkan dalam menu Checkpoint.</p>
        <div class="form-grid">
          <label>Checkpoint
            <select id="qrSelect">
              ${checkpoints.map((cp) => `<option value="${escapeHtml(cp.checkpoint_id)}" ${cp.checkpoint_id === selected.checkpoint_id ? "selected" : ""}>${escapeHtml(cp.checkpoint_id)} - ${escapeHtml(cp.name)}</option>`).join("")}
            </select>
          </label>
          <label>Kod QR / QR Value<input value="${escapeHtml(selected.qr_value)}" readonly></label>
          <button class="btn" data-action="downloadQr">Download PNG</button>
          <button class="btn secondary" data-action="refreshSheet" type="button">Refresh Dari Google Sheet</button>
          <button class="btn secondary" onclick="window.print()">Print</button>
        </div>
        <div class="notice" style="margin-top:14px;">QR Value ialah kod unik yang masuk dalam QR. Bila Guard scan, sistem baca kod ini untuk tahu CP mana yang sedang discan.</div>
      </div>
      <div class="panel">
        <h3>${escapeHtml(selected.checkpoint_id)} - ${escapeHtml(selected.name)}</h3>
        <div class="qr-preview" id="qrPreview"></div>
      </div>
    </section>
    <section class="panel" style="margin-top:16px;">
      <h3>Checkpoint Didaftarkan</h3>
      <p class="muted">Tambah atau ubah CP melalui menu Checkpoint.</p>
      <div class="table-wrap" style="margin-top:14px;">
        <table>
          <thead><tr><th>CP No</th><th>CP Name</th><th>Kod QR</th></tr></thead>
          <tbody>
            ${checkpoints.map((cp) => `
              <tr>
                <td>${escapeHtml(cp.checkpoint_id)}</td>
                <td>${escapeHtml(cp.name)}</td>
                <td>${escapeHtml(cp.qr_value)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderReportsView() {
  const logs = store.get("patrol_logs").slice().reverse();
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Generate Report</h2>
          <p class="muted">Export CSV boleh dibuka semula dalam Excel atau Google Sheets.</p>
        </div>
        <button class="btn" data-action="exportCsv">Export CSV</button>
      </div>
      ${renderLogsTable(logs)}
    </section>
  `;
}

function renderLogsTable(logs) {
  if (!logs.length) return `<p class="muted">Tiada rekod lagi.</p>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Tarikh/Masa</th><th>Guard</th><th>CP</th><th>Coordinate</th><th>Accuracy</th><th>Distance</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${logs.map((log) => `
            <tr>
              <td>${escapeHtml(new Date(log.phone_timestamp).toLocaleString("ms-MY"))}</td>
              <td>${escapeHtml(log.user_name)}<br><span class="muted">${escapeHtml(log.user_id)}</span></td>
              <td>${escapeHtml(log.checkpoint_id)}<br><span class="muted">${escapeHtml(log.checkpoint_name || "")}</span></td>
              <td>${escapeHtml(log.lat)}, ${escapeHtml(log.lng)}</td>
              <td>${escapeHtml(log.accuracy_meter)}m<br>${statusPill(log.accuracy_status)}</td>
              <td>${log.distance_meter === "" ? "-" : `${escapeHtml(log.distance_meter)}m`}</td>
              <td>${statusPill(log.scan_status)}<br><span class="muted">${escapeHtml(log.shift_name || "")} ${escapeHtml(log.patrol_time || "")}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderQrCode() {
  const target = document.getElementById("qrPreview");
  if (!target) return;
  const cp = store.get("checkpoints").find((item) => item.checkpoint_id === state.selectedQr);
  target.innerHTML = "";
  if (window.QRCode) {
    new QRCode(target, {
      text: cp.qr_value,
      width: 256,
      height: 256,
      colorDark: "#172033",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });
  } else {
    target.innerHTML = `<p class="muted">QR library belum loaded. Pastikan internet aktif atau CDN boleh dicapai.</p>`;
  }
}

function bindView() {
  document.querySelector("[data-action='startScan']")?.addEventListener("click", async () => {
    const result = document.getElementById("scanResult");
    if (!window.Html5Qrcode) {
      result.innerHTML = `<span class="pill warn">SCANNER_UNAVAILABLE</span><p>Scanner library belum loaded. Guna manual QR input untuk test.</p>`;
      return;
    }
    stopScanner();
    state.scanLocked = false;
    const scannerOptions = window.Html5QrcodeSupportedFormats
      ? { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false }
      : { verbose: false };
    state.scanner = new Html5Qrcode("reader", scannerOptions);
    result.innerHTML = `<span class="pill warn">CAMERA_ACTIVE</span><p>Halakan kamera terus ke QR. Scan akan dikunci selepas detect pertama.</p>`;
    try {
      await state.scanner.start(
        { facingMode: "environment" },
        {
          fps: 15,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.72);
            return { width: Math.max(240, size), height: Math.max(240, size) };
          },
          aspectRatio: 1,
          disableFlip: false
        },
        (decodedText) => {
          if (state.scanLocked) return;
          state.scanLocked = true;
          result.innerHTML = `<span class="pill good">QR_DETECTED</span><p>QR dikesan. Sedang ambil GPS...</p>`;
          stopScanner();
          handleCheckpointScan(decodedText.trim());
        }
      );
    } catch (error) {
      result.innerHTML = `<span class="pill bad">CAMERA_FAILED</span><p>${escapeHtml(error.message || error)}</p>`;
    }
  });

  document.querySelector("[data-action='manualScan']")?.addEventListener("click", () => {
    const value = document.getElementById("manualQr").value.trim();
    if (value) handleCheckpointScan(value);
  });

  document.getElementById("qrImageInput")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    const result = document.getElementById("scanResult");
    if (!file) return;

    stopScanner();

    try {
      result.innerHTML = `<span class="pill warn">IMAGE_SCANNING</span><p>Sedang baca QR dari gambar...</p>`;
      const decodedText = await decodeQrFromImageFile(file);
      await handleCheckpointScan(decodedText.trim());
    } catch (error) {
      result.innerHTML = `<span class="pill bad">QR_NOT_DETECTED</span><p>QR tidak dapat dibaca dari gambar. Cuba crop gambar supaya QR lebih jelas.</p>`;
    } finally {
      event.target.value = "";
    }
  });

  document.getElementById("userForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const users = store.get("users");
    const user = {
      user_id: String(form.get("user_id")).trim().toUpperCase(),
      name: String(form.get("name")).trim(),
      role: String(form.get("role")),
      pin: String(form.get("pin")).trim(),
      status: "ACTIVE",
      created_at: new Date().toISOString().slice(0, 10)
    };
    const existingIndex = users.findIndex((item) => item.user_id === user.user_id);
    if (existingIndex >= 0) users[existingIndex] = user;
    else users.push(user);
    store.set("users", users);
    await apiPost("saveUser", user);
    renderApp();
  });

  document.getElementById("cpRegisterForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cpNo = Number(String(form.get("cp_no")).trim());
    if (!Number.isInteger(cpNo) || cpNo < 1) {
      alert("CP No mesti nombor 1 dan ke atas.");
      return;
    }

    const checkpointId = `CP${String(cpNo).padStart(3, "0")}`;
    const checkpoints = store.get("checkpoints");
    const existing = checkpoints.find((item) => item.checkpoint_id === checkpointId);
    const checkpoint = {
      checkpoint_id: checkpointId,
      name: String(form.get("name")).trim(),
      qr_value: existing?.qr_value || `${APP_CONFIG.premiseId}_${checkpointId}_${qrTimestamp()}`,
      lat: String(form.get("lat")).trim(),
      lng: String(form.get("lng")).trim(),
      radius_meter: Number(form.get("radius_meter")),
      qr_image_url: "",
      status: "ACTIVE"
    };

    const existingIndex = checkpoints.findIndex((item) => item.checkpoint_id === checkpointId);
    if (existingIndex >= 0) checkpoints[existingIndex] = { ...checkpoints[existingIndex], ...checkpoint };
    else checkpoints.push(checkpoint);
    checkpoints.sort((a, b) => a.checkpoint_id.localeCompare(b.checkpoint_id));

    store.set("checkpoints", checkpoints);
    const apiResult = await apiPost("saveCheckpoint", checkpoint);
    if (apiResult?.ok === false) {
      alert(`Google Sheet save failed: ${apiResult.error || "Unknown error"}`);
      return;
    }
    try {
      await syncFromApi();
    } catch (error) {
      console.warn("Google Sheet sync failed", error);
    }
    state.selectedQr = checkpointId;
    renderApp();
  });

  document.getElementById("shiftForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const shifts = [
      {
        shift_id: "DAY",
        shift_name: "Shift Siang",
        start_time: String(form.get("DAY_start_time")),
        end_time: String(form.get("DAY_end_time")),
        patrol_interval_hour: Number(form.get("DAY_patrol_interval_hour")),
        tolerance_minute: 15,
        status: "ACTIVE"
      },
      {
        shift_id: "NIGHT",
        shift_name: "Shift Malam",
        start_time: String(form.get("NIGHT_start_time")),
        end_time: String(form.get("NIGHT_end_time")),
        patrol_interval_hour: Number(form.get("NIGHT_patrol_interval_hour")),
        tolerance_minute: 15,
        status: "ACTIVE"
      }
    ];
    store.set("shifts", shifts);
    await Promise.all(shifts.map((shift) => apiPost("saveShift", shift)));
    renderApp();
  });

  document.querySelector("[data-action='getRegisterGps']")?.addEventListener("click", async () => {
    const status = document.getElementById("registerGpsStatus");
    const latInput = document.getElementById("registerLat");
    const lngInput = document.getElementById("registerLng");
    status.textContent = "Sedang stabilkan GPS daripada handphone...";
    try {
      const position = await getBestPosition({
        onUpdate: ({ accuracy, bestAccuracy, readings, remaining }) => {
          status.textContent = `GPS reading ${readings}. Accuracy sekarang: ${accuracy}m. Best: ${bestAccuracy}m. Baki: ${remaining}s.`;
        }
      });
      latInput.value = Number(position.coords.latitude).toFixed(6);
      lngInput.value = Number(position.coords.longitude).toFixed(6);
      status.textContent = `GPS captured. Best accuracy: ${Math.round(position.coords.accuracy)}m.`;
    } catch (error) {
      status.textContent = error.message || "GPS gagal dikesan.";
    }
  });

  document.querySelectorAll("[data-action='setCpGps']").forEach((button) => {
    button.addEventListener("click", async () => {
      const cpId = button.dataset.cp;
      button.textContent = "Ambil GPS...";
      try {
        const position = await getCurrentPosition();
        const checkpoints = store.get("checkpoints");
        const cp = checkpoints.find((item) => item.checkpoint_id === cpId);
        cp.lat = Number(position.coords.latitude).toFixed(6);
        cp.lng = Number(position.coords.longitude).toFixed(6);
        store.set("checkpoints", checkpoints);
        await apiPost("saveCheckpoint", cp);
        renderApp();
      } catch (error) {
        alert(error.message || error);
        button.textContent = "Set GPS";
      }
    });
  });

  document.querySelectorAll("[data-action='saveCp']").forEach((button) => {
    button.addEventListener("click", async () => {
      const cpId = button.dataset.cp;
      const checkpoints = store.get("checkpoints");
      const cp = checkpoints.find((item) => item.checkpoint_id === cpId);
      cp.name = document.querySelector(`[data-cp-name='${cpId}']`).value.trim();
      cp.radius_meter = Number(document.querySelector(`[data-cp-radius='${cpId}']`).value);
      store.set("checkpoints", checkpoints);
      await apiPost("saveCheckpoint", cp);
      renderApp();
    });
  });

  document.getElementById("qrSelect")?.addEventListener("change", (event) => {
    state.selectedQr = event.target.value;
    renderApp();
  });

  renderQrCode();

  document.querySelectorAll("[data-action='refreshSheet']").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Refreshing...";
      try {
        await syncFromApi();
        renderApp();
      } catch (error) {
        alert(`Gagal sync Google Sheet: ${error.message || error}`);
        button.textContent = "Refresh Dari Google Sheet";
      }
    });
  });

  document.querySelector("[data-action='downloadQr']")?.addEventListener("click", () => {
    const canvas = document.querySelector("#qrPreview canvas");
    const img = document.querySelector("#qrPreview img");
    const url = canvas ? canvas.toDataURL("image/png") : img?.src;
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.selectedQr}.png`;
    link.click();
  });

  document.querySelector("[data-action='exportCsv']")?.addEventListener("click", () => {
    const logs = store.get("patrol_logs");
    const headers = ["log_id", "user_id", "user_name", "checkpoint_id", "checkpoint_name", "phone_date", "phone_time", "phone_timestamp", "server_timestamp", "lat", "lng", "accuracy_meter", "accuracy_status", "distance_meter", "scan_status", "note"];
    const csv = [
      headers.join(","),
      ...logs.map((log) => headers.map((key) => `"${String(log[key] ?? "").replaceAll("\"", "\"\"")}"`).join(","))
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `patrol-report-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

renderApp();
