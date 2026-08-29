const vscode = acquireVsCodeApi(),
  messages = document.getElementById("messages"),
  input = document.getElementById("input"),
  send = document.getElementById("send"),
  modelDropdown = document.getElementById("modelDropdown"),
  modelButton = document.getElementById("modelButton"),
  modelMenu = document.getElementById("modelMenu"),
  conversationMenu = document.getElementById("conversationMenu"),
  conversationTitle = document.getElementById("conversationTitle"),
  projectIndicatorName = document.getElementById("projectIndicatorName"),
  projectIndicator = document.getElementById("projectIndicator"),
  jumpBottom = document.getElementById("jumpBottom"),
  queued = document.getElementById("queued"),
  queuedText = document.getElementById("queuedText"),
  plan = document.getElementById("plan"),
  browserViewerBackdrop = document.getElementById("browserViewerBackdrop"),
  browserViewerImage = document.getElementById("browserViewerImage"),
  browserViewerCursor = document.getElementById("browserViewerCursor"),
  browserViewerClose = document.getElementById("browserViewerClose");
let runningSet = new Set(),
  activeConversationId = "",
  projectIndicatorPath = "",
  projectIndicatorFolder = "No folder open",
  conversations = [],
  queuedByConversation = new Map(),
  currentTurn = null,
  current = null,
  activity = null,
  activityBody = null,
  phaseStartedAt = 0,
  taskCount = 0,
  lastReasonNode = null,
  reasoningNode = null,
  reasoningSegRef = null,
  followOutput = true,
  gitTracked = Boolean(window.__OPENCODEX_CONFIG__?.gitTracked),
  selectedModel = "",
  modelGroups = [],
  liveByConversation = new Map(),
  latestBrowserPreview = null;
const contextChips = document.getElementById("contextChips");
let editorContext = { activeFile: "", hasSelection: false, selectionLines: "" },
  includeSelection = true,
  contextAttachments = [];
function renderProjectIndicator() {
  projectIndicatorName.textContent =
    editorContext.activeFile || projectIndicatorFolder;
  projectIndicator.title = editorContext.activeFile
    ? "Active file: " + editorContext.activeFile
    : projectIndicatorPath
      ? "Reveal in file explorer"
      : "Current folder in VS Code";
}
function renderContext() {
  const chips = [];
  if (editorContext.hasSelection)
    chips.push(
      '<button class="context-chip' +
        (includeSelection ? "" : " off") +
        '" data-context-toggle="selection" title="Toggle selected code context">Selection ' +
        esc(editorContext.selectionLines) +
        "</button>",
    );
  contextChips.innerHTML = chips.join("");
  contextChips.querySelectorAll("[data-context-toggle]").forEach(
    (button) =>
      (button.onclick = () => {
        includeSelection = !includeSelection;
        renderContext();
      }),
  );
}
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const cursorSvg =
  '<svg viewBox="0 0 22 26" aria-hidden="true"><defs><linearGradient id="cursorGlass" x1="4" y1="3" x2="17" y2="22"><stop stop-color="#e3f5ff" stop-opacity=".78"/><stop offset=".48" stop-color="#73bde9" stop-opacity=".5"/><stop offset="1" stop-color="#3f8fc4" stop-opacity=".66"/></linearGradient></defs><path d="M5.4 3.1c-.9-.7-2.1.1-2 1.2l2.1 17.2c.1 1.1 1.5 1.5 2.2.6l3.7-4.8 6.1-.4c1.1-.1 1.5-1.5.6-2.2Z" fill="url(#cursorGlass)" stroke="#d8f2ff" stroke-opacity=".82" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.6 4.5 7.3 18" fill="none" stroke="#fff" stroke-opacity=".38" stroke-width="1" stroke-linecap="round"/></svg>';
function positionBrowserCursor(marker, image, cursor) {
  if (!marker || !image) return;
  if (!cursor || !image.naturalWidth || !image.naturalHeight) {
    marker.style.display = "none";
    return;
  }
  const frame = image.parentElement,
    fw = frame.clientWidth,
    fh = frame.clientHeight,
    scale = Math.min(fw / image.naturalWidth, fh / image.naturalHeight),
    rw = image.naturalWidth * scale,
    rh = image.naturalHeight * scale,
    x = (fw - rw) / 2 + cursor.x * rw - 2,
    y = (fh - rh) / 2 + cursor.y * rh - 2;
  marker.style.display = "block";
  if (!marker.dataset.positioned) {
    marker.style.transition = "none";
    marker.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    marker.dataset.positioned = "1";
    requestAnimationFrame(() => marker.style.removeProperty("transition"));
  } else marker.style.transform = "translate3d(" + x + "px," + y + "px,0)";
  marker.className = "browser-cursor-marker";
  void marker.offsetWidth;
  marker.classList.add(cursor.action || "click");
}
function applyBrowserPreview(image, marker, preview) {
  if (!preview) return;
  const cursorKey = preview.cursor
    ? [preview.cursor.x, preview.cursor.y, preview.cursor.action].join(":")
    : "";
  const imageChanged = image.__opencodexPreview !== preview.dataUrl,
    cursorChanged = marker.__opencodexCursor !== cursorKey;
  if (!imageChanged && !cursorChanged) return;
  if (!marker.firstChild) marker.innerHTML = cursorSvg;
  marker.__opencodexCursor = cursorKey;
  if (imageChanged) {
    image.__opencodexPreview = preview.dataUrl;
    image.onload = () => positionBrowserCursor(marker, image, preview.cursor);
    image.src = preview.dataUrl;
  }
  if (!imageChanged || image.complete)
    requestAnimationFrame(() =>
      positionBrowserCursor(marker, image, preview.cursor),
    );
}
function closeBrowserViewer() {
  browserViewerBackdrop.classList.remove("open");
}
function openBrowserViewer() {
  if (!latestBrowserPreview) return;
  applyBrowserPreview(
    browserViewerImage,
    browserViewerCursor,
    latestBrowserPreview,
  );
  browserViewerBackdrop.classList.add("open");
  setTimeout(() => browserViewerClose.focus(), 0);
}
function mountBrowserThumbnail() {
  document.querySelectorAll(".browser-thumb").forEach((el) => {
    if (!latestBrowserPreview || el.parentElement !== activityBody) el.remove();
  });
  if (!latestBrowserPreview || !activityBody) return;
  let thumb = activityBody.querySelector(".browser-thumb");
  if (!thumb) {
    thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "browser-thumb";
    thumb.setAttribute("aria-label", "Open browser page viewer");
    thumb.innerHTML =
      '<img class="browser-thumb-image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Browser page"><span class="browser-cursor-marker" aria-hidden="true"></span>';
    thumb.onclick = openBrowserViewer;
  }
  if (activityBody.lastElementChild !== thumb) activityBody.appendChild(thumb);
  applyBrowserPreview(
    thumb.querySelector(".browser-thumb-image"),
    thumb.querySelector(".browser-cursor-marker"),
    latestBrowserPreview,
  );
}
browserViewerClose.onclick = closeBrowserViewer;
browserViewerBackdrop.onclick = (e) => {
  if (e.target === browserViewerBackdrop) closeBrowserViewer();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && browserViewerBackdrop.classList.contains("open"))
    closeBrowserViewer();
});
window.addEventListener("resize", () => {
  if (latestBrowserPreview) {
    const thumb = document.querySelector(".browser-thumb");
    if (thumb)
      positionBrowserCursor(
        thumb.querySelector(".browser-cursor-marker"),
        thumb.querySelector(".browser-thumb-image"),
        latestBrowserPreview.cursor,
      );
    if (browserViewerBackdrop.classList.contains("open"))
      positionBrowserCursor(
        browserViewerCursor,
        browserViewerImage,
        latestBrowserPreview.cursor,
      );
  }
});
const notifyBackdrop = document.getElementById("notifyBackdrop"),
  notifyModal = document.getElementById("notifyModal"),
  notifyTitle = document.getElementById("notifyTitle"),
  notifyBody = document.getElementById("notifyBody"),
  notifyIcon = document.getElementById("notifyIcon"),
  notifyOk = document.getElementById("notifyOk"),
  notifyCancel = document.getElementById("notifyCancel"),
  notifySecondary = document.getElementById("notifySecondary"),
  notifyClose = document.getElementById("notifyClose");
let notifyQueue = [],
  notifyBusy = false;
function showNotifyModal(opts) {
  return new Promise((resolve) => {
    notifyQueue.push({ opts, resolve });
    drainNotify();
  });
}
function drainNotify() {
  if (notifyBusy || !notifyQueue.length) return;
  notifyBusy = true;
  const job = notifyQueue.shift(),
    opts = job.opts;
  notifyTitle.textContent = opts.title || "Opencodex";
  notifyBody.textContent = opts.body || "";
  notifyModal.classList.toggle("danger", Boolean(opts.danger));
  notifyIcon.style.display = opts.icon === false ? "none" : "";
  notifyOk.textContent = opts.ok || "OK";
  notifyOk.classList.toggle("danger", Boolean(opts.danger));
  notifyCancel.textContent = opts.cancel || "Cancel";
  notifyCancel.style.display = opts.cancel ? "" : "none";
  notifySecondary.textContent = opts.secondary || "";
  notifySecondary.style.display = opts.secondary ? "" : "none";
  notifyBackdrop.classList.add("open");
  setTimeout(() => {
    (opts.cancel !== false ? notifyCancel : notifyOk).focus();
  }, 0);
  window.__resolveNotify = (choice) => {
    notifyBusy = false;
    notifyBackdrop.classList.remove("open");
    job.resolve(choice);
    drainNotify();
  };
}
notifyOk.onclick = () => {
  if (window.__resolveNotify) window.__resolveNotify("ok");
};
notifyCancel.onclick = () => {
  if (window.__resolveNotify) window.__resolveNotify("cancel");
};
notifySecondary.onclick = () => {
  if (window.__resolveNotify) window.__resolveNotify("secondary");
};
notifyClose.onclick = () => {
  if (window.__resolveNotify) window.__resolveNotify("cancel");
};
notifyBackdrop.onclick = (e) => {
  if (e.target === notifyBackdrop && window.__resolveNotify)
    window.__resolveNotify("cancel");
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && window.__resolveNotify)
    window.__resolveNotify("cancel");
});
const displayModel = (s) => String(s || "").toLowerCase();
const usageView = document.getElementById("usageView"),
  usageContent = document.getElementById("usageContent"),
  usageNav = document.getElementById("usageNav");
let usageData = null,
  liveRuns = new Map(),
  usageTimer = null,
  usagePeriod = "today";
const marketplaceView = document.getElementById("marketplaceView"),
  marketplaceNav = document.getElementById("marketplaceNav"),
  marketplaceSearchEl = document.getElementById("marketplaceSearch"),
  marketplaceDiscover = document.getElementById("marketplaceDiscover"),
  marketplaceInstalledPane = document.getElementById(
    "marketplaceInstalledPane",
  ),
  marketplaceResults = document.getElementById("marketplaceResults"),
  marketplaceInstalledEl = document.getElementById("marketplaceInstalled"),
  marketplaceStatus = document.getElementById("marketplaceStatus"),
  marketplaceQuery = document.getElementById("marketplaceQuery"),
  marketplaceRepo = document.getElementById("marketplaceRepo"),
  marketplaceSort = document.getElementById("marketplaceSort"),
  previewModal = document.getElementById("previewModal"),
  previewContent = document.getElementById("previewContent"),
  previewInstall = document.getElementById("previewInstall"),
  previewProgress = document.getElementById("previewProgress"),
  previewProgressFill = document.getElementById("previewProgressFill"),
  previewProgressLabel = document.getElementById("previewProgressLabel");
let installedSkills = [],
  marketplaceCards = [],
  marketplaceActions = [],
  marketplaceBusy = false,
  previewState = null,
  marketplaceTab = "discover",
  marketplaceTopLoaded = false,
  installSeq = 0,
  marketplaceDebounce = 0,
  marketplaceInstalling = {};
function marketplaceStatusText(text, ok) {
  marketplaceStatus.textContent = text || "";
  marketplaceStatus.className =
    "marketplace-status" + (ok ? " ok" : ok === false ? " bad" : "");
}
function installedMatch(author, name) {
  const rawName = String(name || "");
  const n = rawName.toLowerCase();
  const normName = n.replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
  const authorKey = String(author || "")
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "");
  const aParts = authorKey.split("/").filter(Boolean);
  const aUser = aParts[0] || "";
  const aRepo = aParts[1] || "";
  return installedSkills.some((x) => {
    const xName = String(x.name || "").toLowerCase();
    if (x.source) {
      const s = String(x.source).toLowerCase().replace(/\/+$/, "");
      const sParts = s.split("/").filter(Boolean);
      if (sParts[0] === aUser && (!aRepo || sParts[1] === aRepo) && xName === n)
        return true;
      return false;
    }
    return x.folder === normName || xName === n;
  });
}
function renderMarketplaceNav() {
  marketplaceNav.innerHTML = [
    ["discover", "Discover"],
    [
      "installed",
      "Installed" +
        (installedSkills.length ? " (" + installedSkills.length + ")" : ""),
    ],
  ]
    .map(
      ([id, label]) =>
        '<button class="period-pill' +
        (id === marketplaceTab ? " active" : "") +
        '" data-tab="' +
        id +
        '">' +
        label +
        "</button>",
    )
    .join("");
  marketplaceNav.querySelectorAll(".period-pill").forEach((btn) => {
    btn.onclick = () => selectMarketplaceTab(btn.dataset.tab);
  });
}
function selectMarketplaceTab(tab) {
  if (!tab) return;
  marketplaceTab = tab;
  renderMarketplaceNav();
  marketplaceSearchEl.classList.toggle(
    "hidden",
    marketplaceTab === "installed",
  );
  marketplaceDiscover.classList.toggle("active", marketplaceTab === "discover");
  marketplaceInstalledPane.classList.toggle(
    "active",
    marketplaceTab === "installed",
  );
  if (marketplaceTab === "installed")
    vscode.postMessage({ type: "requestMarketplaceInstalled" });
}
function renderInstalledSkills() {
  renderMarketplaceNav();
  if (!installedSkills.length) {
    marketplaceInstalledEl.innerHTML =
      '<div class="marketplace-empty">No skills yet.<br>Find one in the Discover tab and hit Install.</div>';
    return;
  }
  marketplaceInstalledEl.innerHTML =
    '<div class="installed-rows">' +
    installedSkills
      .map(
        (x) =>
          '<div class="installed-row" title="' +
          esc(x.skillMdPath) +
          '"><button class="installed-row-remove" data-uninstall="' +
          esc(x.folder) +
          '" title="Uninstall ' +
          esc(x.name) +
          '"><svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button><div class="installed-row-body"><div class="installed-row-name">' +
          esc(x.name) +
          "</div>" +
          (x.description
            ? '<div class="installed-row-desc">' + esc(x.description) + "</div>"
            : "") +
          '<div class="installed-row-src">' +
          (x.source ? "from " + esc(x.source) : "") +
          '</div><div class="installed-row-path" data-reveal="' +
          esc(x.folder) +
          '" title="Reveal in file explorer"><svg viewBox="0 0 24 24"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><span>' +
          esc(x.skillMdPath) +
          "</span></div></div></div>",
      )
      .join("") +
    "</div>";
  marketplaceInstalledEl.querySelectorAll("[data-uninstall]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: "marketplaceUninstall",
        folder: btn.dataset.uninstall,
      });
    };
  });
  marketplaceInstalledEl.querySelectorAll("[data-reveal]").forEach((el) => {
    el.onclick = () =>
      vscode.postMessage({ type: "revealSkill", folder: el.dataset.reveal });
  });
}
function installingForCard(cardKey) {
  for (const key in marketplaceInstalling) {
    const st = marketplaceInstalling[key];
    if (st && st.cardKey && st.cardKey === cardKey) return st;
  }
  return null;
}
function progressPct(st) {
  const total = (st && st.total) || 0;
  return total > 0
    ? Math.min(100, Math.round((((st && st.done) || 0) / total) * 100))
    : 6;
}
function renderMarketplaceResults() {
  if (marketplaceBusy) {
    marketplaceResults.innerHTML =
      '<div class="marketplace-empty"><span class="spinner"></span></div>';
    return;
  }
  if (!marketplaceCards.length) {
    marketplaceResults.innerHTML =
      '<div class="marketplace-empty">Search the marketplace or browse a GitHub repo to find skills to install.</div>';
    return;
  }
  marketplaceResults.innerHTML =
    '<div class="marketplace-section-title">Results</div><div class="skill-list">' +
    marketplaceCards
      .map((card, index) => {
        const installed = installedMatch(card.author, card.name);
        const installing = installingForCard(card.key || "");
        let actions = "";
        if (installing) {
          actions =
            '<div class="skill-progress"><div class="skill-progress-bar"><div class="skill-progress-fill" style="width:' +
            progressPct(installing) +
            '%"></div></div><div class="skill-progress-label">' +
            esc(installing.label) +
            "</div></div>";
        } else {
          actions = installed
            ? '<span class="skill-installed-badge">Installed</span>'
            : (marketplaceActions[index] && marketplaceActions[index].preview
                ? '<button class="small-btn" data-skill-action="' +
                  index +
                  '" data-action="preview">Preview</button>'
                : "") +
              (marketplaceActions[index] && marketplaceActions[index].install
                ? '<button class="primary" data-skill-action="' +
                  index +
                  '" data-action="install">Install</button>'
                : "");
        }
        return (
          '<div class="skill-card" data-key="' +
          esc(card.key || "") +
          '"><div class="skill-card-head"><span class="skill-card-name" title="' +
          esc(card.name) +
          '">' +
          esc(card.name) +
          '</span><span class="skill-card-meta">' +
          card.meta +
          "</span></div>" +
          (card.description
            ? '<p class="skill-card-desc">' + esc(card.description) + "</p>"
            : "") +
          '<div class="skill-card-actions">' +
          actions +
          "</div></div>"
        );
      })
      .join("") +
    '</div><div class="marketplace-results-footer">Retrieved from SkillsMP</div>';
  marketplaceResults.querySelectorAll("[data-skill-action]").forEach((btn) => {
    btn.onclick = () =>
      skillAction(Number(btn.dataset.skillAction), btn.dataset.action);
  });
}
function skillAction(index, action) {
  const entry = marketplaceActions[index];
  if (!entry || !entry[action]) return;
  if (action === "preview") {
    openSkillPreview(
      entry.preview.source,
      entry.preview.path || "",
      null,
      index,
    );
    return;
  }
  if (action === "install") {
    startSkillInstall(index);
  }
}
function startSkillInstall(index, override) {
  const entry = override || marketplaceActions[index];
  if (!entry || !entry.install) return;
  const key = "inst-" + ++installSeq;
  const cardKey =
    index >= 0 && marketplaceCards[index]
      ? marketplaceCards[index].key
      : (previewState && previewState.cardKey) || "";
  marketplaceInstalling[key] = {
    cardKey,
    done: 0,
    total: 0,
    label: "Installing…",
  };
  if (override && previewState) previewState.key = key;
  renderMarketplaceResults();
  updatePreviewProgress(key);
  vscode.postMessage({
    type: "marketplaceInstall",
    source: entry.install.source,
    skill: entry.install.skill,
    key,
  });
}
function updateCardProgress(key) {
  const st = marketplaceInstalling[key];
  if (!st || !st.cardKey) return;
  const cardEl = marketplaceResults.querySelector(
    '.skill-card[data-key="' + CSS.escape(st.cardKey) + '"]',
  );
  if (!cardEl) return;
  const fill = cardEl.querySelector(".skill-progress-fill");
  const label = cardEl.querySelector(".skill-progress-label");
  if (fill) fill.style.width = progressPct(st) + "%";
  if (label) label.textContent = st.label || "Installing…";
}
function updatePreviewProgress(key) {
  const st = marketplaceInstalling[key];
  const active = Boolean(
    previewState &&
    previewState.key === key &&
    previewModal.classList.contains("open"),
  );
  previewProgress.classList.toggle("visible", active && Boolean(st));
  previewProgress.classList.toggle("error", active && Boolean(st && st.error));
  if (!active || !st) return;
  previewProgressFill.style.width = progressPct(st) + "%";
  previewProgressLabel.textContent = st.label || "Installing…";
}
function openSkillPreview(source, path, title, origin) {
  previewState = {
    source,
    path,
    origin,
    cardKey:
      origin >= 0 && marketplaceCards[origin]
        ? marketplaceCards[origin].key
        : "",
    key: "",
  };
  previewModal.classList.add("open");
  previewContent.textContent = "Loading…";
  previewInstall.style.display = "none";
  previewProgress.classList.remove("visible", "error");
  document.getElementById("previewTitle").textContent =
    title || "Skill preview";
  vscode.postMessage({
    type: "marketplacePreview",
    source,
    path: path || undefined,
  });
}
function closeSkillPreview() {
  previewModal.classList.remove("open");
  previewState = null;
  previewProgress.classList.remove("visible", "error");
}
function loadMarketplaceTop(force, sortBy) {
  if (marketplaceTopLoaded && !force) return;
  marketplaceTopLoaded = true;
  marketplaceBusy = true;
  marketplaceCards = [];
  marketplaceActions = [];
  marketplaceStatusText("");
  renderMarketplaceResults();
  vscode.postMessage({ type: "marketplaceTop", sortBy: sortBy || "stars" });
}
function openMarketplaceView() {
  document.querySelector(".app").style.display = "none";
  marketplaceView.classList.add("visible");
  renderInstalledSkills();
  selectMarketplaceTab(marketplaceTab);
  renderMarketplaceResults();
  if (!marketplaceCards.length) loadMarketplaceTop();
}
function closeMarketplaceView() {
  marketplaceView.classList.remove("visible");
  document.querySelector(".app").style.display = "flex";
}
function marketplaceSearch() {
  const query = marketplaceQuery.value.trim();
  if (!query) return;
  marketplaceTopLoaded = true;
  marketplaceBusy = true;
  marketplaceCards = [];
  marketplaceActions = [];
  marketplaceStatusText("");
  renderMarketplaceResults();
  vscode.postMessage({
    type: "marketplaceSearch",
    query,
    limit: 12,
    sortBy: marketplaceSort.value,
  });
}
function runMarketplaceSearch(live) {
  const run = () => {
    const q = marketplaceQuery.value.trim();
    q ? marketplaceSearch() : loadMarketplaceTop(true, marketplaceSort.value);
  };
  if (!live) {
    run();
    return;
  }
  clearTimeout(marketplaceDebounce);
  marketplaceDebounce = setTimeout(run, 300);
}
function marketplaceListRepo() {
  const source = marketplaceRepo.value.trim();
  if (!source) return;
  marketplaceTopLoaded = true;
  marketplaceBusy = true;
  marketplaceCards = [];
  marketplaceActions = [];
  marketplaceStatusText("");
  renderMarketplaceResults();
  vscode.postMessage({ type: "marketplaceListRepo", source });
}
const USAGE_PERIODS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["week", "7 days"],
  ["month", "30 days"],
];
const zeroTokens = () => ({ input: 0, output: 0 });
const trimNum = (s) => s.replace(/\.?0+$/, "");
const fmt = (n) => {
  n = n || 0;
  if (n >= 1000000) return trimNum((n / 1000000).toFixed(2)) + "M";
  if (n >= 1000) return trimNum((n / 1000).toFixed(1)) + "k";
  return String(n);
};
const tokenText = (t) =>
  '<span class="tokens" title="' +
  t.input.toLocaleString() +
  " input · " +
  t.output.toLocaleString() +
  ' output">' +
  (t.input ? fmt(t.input) : "0") +
  '<span class="sep">/</span>' +
  (t.output ? fmt(t.output) : "0") +
  "</span>";
function renderUsage() {
  const data = usageData || { models: [], totals: {} };
  const models = data.models || [],
    totals = data.totals || {};
  let live = { input: 0, output: 0 };
  for (const v of liveRuns.values()) {
    live.input += v.input || 0;
    live.output += v.output || 0;
  }
  const hasUsage = models.length > 0 || live.input > 0 || live.output > 0;
  usageNav.innerHTML = USAGE_PERIODS.map(
    ([id, label]) =>
      '<button class="period-pill' +
      (id === usagePeriod ? " active" : "") +
      '" data-period="' +
      id +
      '">' +
      label +
      "</button>",
  ).join("");
  usageNav.querySelectorAll(".period-pill").forEach((btn) => {
    btn.onclick = () => {
      usagePeriod = btn.dataset.period;
      renderUsage();
    };
  });
  if (!hasUsage) {
    usageContent.innerHTML =
      '<div class="usage-empty">No token usage recorded yet.<br>Usage is tracked live while responses stream.</div>';
    return;
  }
  const liveByModel = new Map();
  for (const v of liveRuns.values()) {
    if (!v.input && !v.output) continue;
    const key = (v.model || "") + "|" + (v.provider || "");
    const e = liveByModel.get(key) || {
      model: v.model,
      provider: v.provider,
      input: 0,
      output: 0,
    };
    e.input += v.input || 0;
    e.output += v.output || 0;
    liveByModel.set(key, e);
  }
  const rows = [];
  const seen = new Set();
  for (const m of models) {
    const key = m.model + "|" + (m.provider || "");
    seen.add(key);
    const base = (m.periods && m.periods[usagePeriod]) || zeroTokens();
    const l = usagePeriod === "today" ? liveByModel.get(key) : undefined;
    const tokens = {
      input: base.input + (l ? l.input : 0),
      output: base.output + (l ? l.output : 0),
    };
    if (tokens.input || tokens.output)
      rows.push({ model: m.model, provider: m.provider || "", tokens });
  }
  for (const [key, v] of liveByModel) {
    if (seen.has(key)) continue;
    rows.push({
      model: v.model,
      provider: v.provider || "",
      tokens: { input: v.input, output: v.output },
    });
  }
  rows.sort(
    (a, b) =>
      b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output) ||
      a.model.localeCompare(b.model),
  );
  const total =
    usagePeriod === "today"
      ? {
          input: ((totals.today && totals.today.input) || 0) + live.input,
          output: ((totals.today && totals.today.output) || 0) + live.output,
        }
      : totals[usagePeriod] || zeroTokens();
  const rowHtml = (r) =>
    '<div class="usage-row"><div class="usage-model"><div class="model-id" title="' +
    esc(r.model) +
    '">' +
    esc(displayModel(r.model)) +
    '</div><div class="provider">' +
    esc(r.provider) +
    "</div></div>" +
    tokenText(r.tokens) +
    "</div>";
  usageContent.innerHTML =
    '<div class="usage-list">' +
    rows.map(rowHtml).join("") +
    '<div class="usage-row total"><div class="usage-model"><div class="model-id">All models</div><div class="provider">input / output</div></div>' +
    tokenText(total) +
    "</div></div>";
}
function openUsageView() {
  document.querySelector(".app").style.display = "none";
  usageView.classList.add("visible");
  renderUsage();
  clearInterval(usageTimer);
  usageTimer = setInterval(
    () => vscode.postMessage({ type: "requestUsage" }),
    3000,
  );
}
function closeUsageView() {
  usageView.classList.remove("visible");
  document.querySelector(".app").style.display = "flex";
  clearInterval(usageTimer);
  usageTimer = null;
}
const nearBottom = () =>
  messages.scrollHeight - messages.scrollTop - messages.clientHeight < 42;
const isRunning = () => runningSet.has(activeConversationId);
function updateJump() {
  const away = !nearBottom();
  jumpBottom.style.bottom =
    document.querySelector(".composer").offsetHeight + 10 + "px";
  jumpBottom.classList.toggle("visible", away);
  jumpBottom.classList.toggle("working", away && isRunning());
}
const pinScroll = () => {
  if (followOutput) messages.scrollTop = messages.scrollHeight;
};
const scroll = (force = false) => {
  if (force || followOutput) pinScroll();
  updateJump();
  requestAnimationFrame(() => {
    if (followOutput) pinScroll();
    updateJump();
  });
};
function scrollActivity() {
  mountBrowserThumbnail();
  const body = activityBody,
    details = activity;
  requestAnimationFrame(() => {
    if (body && details?.open && followOutput)
      body.scrollTop = body.scrollHeight;
  });
  scroll();
}
function freshLive() {
  return {
    userItem: null,
    phase: "thinking",
    plan: null,
    currentRaw: "",
    errorText: null,
    errorRetry: false,
    reasoning: "",
    work: [],
    taskCount: 0,
  };
}
function liveState(convId) {
  let s = liveByConversation.get(convId);
  if (!s) {
    s = freshLive();
    liveByConversation.set(convId, s);
  }
  return s;
}
function ensureTurn() {
  if (currentTurn) return currentTurn;
  const turn = document.querySelector(".turn:last-child");
  currentTurn = turn;
  if (turn) {
    const det = turn.querySelector(".activity");
    if (det) {
      activity = det;
      activityBody = det.querySelector(".activity-body");
    }
    current = turn.querySelector("div.assistant");
  }
  return turn;
}
function mountActivity() {
  if (!currentTurn) ensureTurn();
  if (activity || !currentTurn) return;
  closeCurrentText();
  activity = document.createElement("details");
  activity.className = "activity loading";
  activity.open = true;
  activity.innerHTML =
    '<summary>Thinking</summary><div class="activity-body"></div>';
  activityBody = activity.querySelector(".activity-body");
  currentTurn.appendChild(activity);
  phaseStartedAt = Date.now();
  taskCount = 0;
}
function renderLive(convId) {
  const s = liveByConversation.get(convId);
  if (!s) return;
  const turn = document.querySelector(".turn:last-child");
  if (!turn) return;
  currentTurn = turn;
  current = activity = activityBody = null;
  reasoningNode = reasoningSegRef = lastReasonNode = null;
  taskCount = 0;
  if (s.plan) showPlan(s.plan);
  appendTranscriptFlow(
    turn,
    { text: s.currentRaw || "", kind: undefined, seconds: 0 },
    s.work || [],
  );
  const tail = turn.lastElementChild;
  if (tail?.classList.contains("assistant")) {
    current = tail;
    current.classList.add("streaming");
  } else if (tail?.classList.contains("activity")) {
    activity = tail;
    activityBody = activity.querySelector(".activity-body");
    activity.classList.add("loading");
    activity.open = true;
    taskCount = activityBody.querySelectorAll(".tool").length;
    const last = s.work?.[s.work.length - 1];
    if (last?.t === "reasoning") {
      reasoningSegRef = last;
      const nodes = activityBody.querySelectorAll(".reasoning");
      reasoningNode = nodes[nodes.length - 1] || null;
    }
  }
  if (s.errorText) {
    const d = document.createElement("div");
    d.className = "error";
    d.textContent = s.errorText;
    if (s.errorRetry) d.appendChild(errorActions());
    turn.appendChild(d);
  }
  phaseStartedAt = Date.now();
  followOutput = true;
  if (activity) scrollActivity();
  else scroll(true);
}
function updateQueuedVisibility() {
  const prompt = queuedByConversation.get(activeConversationId) || null;
  const show = Boolean(prompt);
  queued.classList.toggle("visible", show);
  queuedText.textContent = show ? prompt : "";
  document.getElementById("steerQueued").style.display =
    show && runningSet.has(activeConversationId) ? "" : "none";
  updateJump();
}
function inlineMarkdown(raw) {
  const tick = String.fromCharCode(96),
    tokenStart = String.fromCharCode(57344),
    tokenEnd = String.fromCharCode(57345),
    codes = [];
  let line = esc(raw);
  line = line.replace(
    new RegExp(tick + "([^" + tick + "\\n]+)" + tick, "g"),
    (_, code) => {
      codes.push(code);
      return tokenStart + (codes.length - 1) + tokenEnd;
    },
  );
  line = line
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
  return line.replace(
    new RegExp(tokenStart + "(\\d+)" + tokenEnd, "g"),
    (_, index) => "<code>" + codes[Number(index)] + "</code>",
  );
}
function markdown(raw) {
  const fence = String.fromCharCode(96).repeat(3),
    lines = String(raw).split(/\r?\n/);
  let html = "",
    inCode = false,
    code = "",
    list = "",
    paragraph = [],
    table = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html += "<p>" + paragraph.map(inlineMarkdown).join(" ") + "</p>";
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      html += "</" + list + ">";
      list = "";
    }
  };
  const isSep = (r) => r.every((c) => /^:?-{1,}:?$/.test(c));
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !isSep(r));
    if (rows.length) {
      html += "<table>";
      rows.forEach((r, i) => {
        const tag = i ? "td" : "th";
        html +=
          "<tr>" +
          r
            .map((c) => "<" + tag + ">" + inlineMarkdown(c) + "</" + tag + ">")
            .join("") +
          "</tr>";
      });
      html += "</table>";
    }
    table = [];
  };
  for (const rawLine of lines) {
    if (rawLine.trim().startsWith(fence)) {
      flushParagraph();
      closeList();
      flushTable();
      if (inCode) {
        html += "<pre><code>" + esc(code.replace(/\n$/, "")) + "</code></pre>";
        code = "";
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code += rawLine + "\n";
      continue;
    }
    const trow = rawLine.match(/^\s*\|(.*)\|\s*$/);
    if (trow && trow[1].includes("|")) {
      if (!table.length) {
        flushParagraph();
        closeList();
      }
      table.push(trow[1].split("|").map((c) => c.trim()));
      continue;
    }
    if (table.length) flushTable();
    const item = rawLine.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (item) {
      flushParagraph();
      const type = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== type) {
        closeList();
        html += "<" + type + ">";
        list = type;
      }
      html += "<li>" + inlineMarkdown(item[2]) + "</li>";
      continue;
    }
    closeList();
    if (!rawLine.trim()) {
      flushParagraph();
      continue;
    }
    const heading = rawLine.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html +=
        "<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">";
      continue;
    }
    const quote = rawLine.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      html += "<blockquote>" + inlineMarkdown(quote[1]) + "</blockquote>";
      continue;
    }
    paragraph.push(rawLine.trim());
  }
  flushParagraph();
  closeList();
  flushTable();
  if (inCode)
    html += "<pre><code>" + esc(code.replace(/\n$/, "")) + "</code></pre>";
  return html;
}
const emptyState = () => {
  const recent = conversations
    .filter((x) => !x.archived && x.hasMessages)
    .slice(0, 5);
  return (
    '<div class="empty" id="empty"><div class="empty-inner"><img class="empty-mark" src="' +
    window.__OPENCODEX_CONFIG__.markUri +
    '" alt=""><h2>What should I build?</h2>' +
    (recent.length
      ? '<div class="recent"><div class="recent-head"><span>Recent conversations</span><span class="count">' +
        recent.length +
        '</span></div><div class="recent-list">' +
        recent
          .map(
            (x) =>
              '<div class="recent-item" data-open-recent="' +
              esc(x.id) +
              '" title="' +
              esc(x.title) +
              '">' +
              (x.running ? '<span class="spinner"></span>' : "") +
              '<span class="title">' +
              esc(x.title) +
              '</span><span class="time">' +
              recentTimeLabel(x.updatedAt) +
              '</span><button class="archive-action" data-archive-recent="' +
              esc(x.id) +
              '" title="Archive" aria-label="Archive ' +
              esc(x.title) +
              '"><svg viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg></button></div>',
          )
          .join("") +
        "</div></div>"
      : "") +
    "</div></div>"
  );
};
function bindRecent(scope) {
  scope.querySelectorAll("[data-open-recent]").forEach(
    (el) =>
      (el.onclick = () =>
        vscode.postMessage({
          type: "openConversation",
          id: el.dataset.openRecent,
        })),
  );
  scope.querySelectorAll("[data-archive-recent]").forEach(
    (el) =>
      (el.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: "archiveConversation",
          id: el.dataset.archiveRecent,
        });
      }),
  );
}
function refreshEmpty() {
  const el = document.getElementById("empty");
  if (!el) return;
  el.outerHTML = emptyState();
  const empty = document.getElementById("empty");
  if (empty) bindRecent(empty);
}
const timeLabel = (value) =>
  new Date(value || Date.now()).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
const recentTimeLabel = (value) =>
  new Date(value || Date.now()).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
function messageFooter(item, isAssistant) {
  const footer = document.createElement("div");
  footer.className =
    "message-footer" + (isAssistant ? " assistant-footer" : "");
  const time = document.createElement("span");
  time.textContent = timeLabel(item.timestamp);
  footer.appendChild(time);
  const copy = document.createElement("button");
  copy.className = "message-action";
  copy.title = "Copy";
  copy.setAttribute("aria-label", "Copy message");
  copy.innerHTML =
    '<svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  copy.onclick = () =>
    vscode.postMessage({ type: "copyText", text: item.text });
  footer.appendChild(copy);
  if (!isAssistant) {
    const edit = document.createElement("button");
    edit.className = "message-action";
    edit.title = "Edit message";
    edit.setAttribute("aria-label", "Edit message");
    edit.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    edit.onclick = () => startEditMessage(item);
    footer.appendChild(edit);
  }
  if (isAssistant && gitTracked && item.gitTree) {
    const restore = document.createElement("button");
    restore.className = "message-action";
    restore.title = "Restore here";
    restore.setAttribute("aria-label", "Restore workspace to this message");
    restore.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
    restore.onclick = () =>
      vscode.postMessage({
        type: "restoreCheckpoint",
        conversationId: activeConversationId,
        itemId: item.id,
      });
    footer.appendChild(restore);
  }
  return footer;
}
function userBubble(item) {
  const row = document.createElement("div");
  row.className = "user-row";
  const wrapper = document.createElement("div");
  wrapper.className = "user-message";
  const text = document.createElement("div");
  text.className = "user-text";
  text.textContent = item.text;
  wrapper.append(text, messageFooter(item, false));
  row.appendChild(wrapper);
  return row;
}
function closeCurrentText() {
  if (current) current.classList.remove("streaming");
  current = null;
}
function renderReasoning(seg) {
  if (!activity || !activityBody) {
    if (!currentTurn) ensureTurn();
    if (!activity || !activityBody) {
      if (!currentTurn) return;
      mountActivity();
      if (!activity || !activityBody) return;
    }
  }
  if (reasoningSegRef !== seg || !reasoningNode) {
    const node = document.createElement("div");
    node.className = "reasoning";
    activityBody.appendChild(node);
    reasoningNode = node;
    reasoningSegRef = seg;
  }
  reasoningNode.innerHTML = markdown(seg.text || "");
  enableActivity();
  scrollActivity();
}
function endReasoningSegment() {
  reasoningSegRef = null;
  reasoningNode = null;
}
function createActivity() {
  mountActivity();
}
function ensureActivity() {
  if (!activity) mountActivity();
}
function createTextSegment() {
  if (current) return current;
  if (!currentTurn) ensureTurn();
  if (!currentTurn) return null;
  if (activity) {
    finishActivity();
    activity = null;
    activityBody = null;
    reasoningNode = null;
    reasoningSegRef = null;
  }
  current = assistantSegment("", undefined, true);
  currentTurn.appendChild(current);
  return current;
}
function planCard(title, steps, activeStep, doneSteps, interrupted) {
  const d = document.createElement("div");
  d.className = "plan";
  const head = document.createElement("div");
  head.className = "plan-head";
  const h = document.createElement("div");
  h.className = "plan-title";
  h.textContent = title || "Plan";
  head.appendChild(h);
  if (interrupted) {
    const badge = document.createElement("span");
    badge.className = "plan-badge";
    badge.textContent = "Interrupted";
    head.appendChild(badge);
  }
  const dismiss = document.createElement("button");
  dismiss.className = "plan-dismiss";
  dismiss.title = "Dismiss plan";
  dismiss.setAttribute("aria-label", "Dismiss plan");
  dismiss.textContent = "×";
  dismiss.onclick = () => {
    if (plan && plan.contains(d)) hidePlan();
    else d.remove();
  };
  head.appendChild(dismiss);
  d.appendChild(head);
  const doneSet = new Set(doneSteps || []);
  const list = steps || [];
  if (list.length) {
    const ol = document.createElement("ol");
    ol.className = "plan-steps";
    list.forEach((s, index) => {
      const isDone = doneSet.has(index);
      const isActive = index === activeStep && !isDone && !interrupted;
      const isPaused = index === activeStep && !isDone && interrupted;
      const li = document.createElement("li");
      li.className =
        "plan-step" +
        (isDone ? " done" : "") +
        (isActive ? " active" : "") +
        (isPaused ? " paused" : "");
      const state = document.createElement("span");
      state.className = "plan-state";
      state.textContent = isDone ? "✓" : isPaused ? "⏸" : "";
      const label = document.createElement("span");
      label.className = "plan-label";
      label.textContent = s;
      li.append(state, label);
      ol.appendChild(li);
    });
    d.appendChild(ol);
  }
  return d;
}
function showPlan(m) {
  plan.classList.add("visible");
  plan.classList.toggle("done", Boolean(m.done));
  plan.classList.toggle("interrupted", Boolean(m.interrupted));
  plan.innerHTML = "";
  plan.appendChild(
    planCard(
      m.title,
      m.steps,
      m.activeStep,
      m.doneSteps,
      Boolean(m.interrupted),
    ),
  );
  scroll();
}
function hidePlan() {
  plan.classList.remove("visible");
}
function beginTurn(item) {
  document.getElementById("empty")?.remove();
  currentTurn = document.createElement("section");
  currentTurn.className = "turn";
  currentTurn.appendChild(userBubble(item));
  messages.appendChild(currentTurn);
  current = activity = activityBody = null;
  reasoningNode = null;
  reasoningSegRef = null;
  lastReasonNode = null;
  scroll(true);
}
function buildWorkNode(w) {
  const row = document.createElement("div");
  row.className = "tool" + (w.done === false ? "" : " done");
  row.innerHTML =
    '<span class="task-state"></span><div class="task-label">' +
    markdown(w.text || "") +
    "</div>";
  return row;
}
function assistantSegment(text, kind, streaming) {
  const node = document.createElement("div");
  node.className =
    (kind === "error" ? "assistant error-card" : "assistant") +
    (streaming ? " streaming" : "");
  node.dataset.raw = text || "";
  if (kind === "error") node.textContent = text || "";
  else node.innerHTML = markdown(text || "");
  return node;
}
function activityLabel(entries, seconds, includeSeconds) {
  const tasks = entries.filter(
    (w) => w.kind === "task" || w.t === "tool" || w.t === "retry",
  );
  const timed =
    includeSeconds && seconds > 1 ? " for " + Math.round(seconds) + "s" : "";
  return tasks.length
    ? "Worked" +
        timed +
        (tasks.length
          ? " · " + tasks.length + " task" + (tasks.length === 1 ? "" : "s")
          : "")
    : "Thought" + timed;
}
function transcriptActivity(entries, seconds, includeSeconds) {
  const det = document.createElement("details");
  det.className = "activity has-content";
  det.innerHTML = '<summary></summary><div class="activity-body"></div>';
  det.querySelector("summary").textContent = activityLabel(
    entries,
    seconds,
    includeSeconds,
  );
  const body = det.querySelector(".activity-body");
  for (const w of entries) {
    if (w.kind === "reasoning" || w.t === "reasoning") {
      const rn = document.createElement("div");
      rn.className = "reasoning";
      rn.innerHTML = markdown(w.text || "");
      body.appendChild(rn);
    } else if (w.t === "changed") {
      const changed = document.createElement("div");
      changed.className = "changed";
      changed.textContent = w.text;
      changed.onclick = () =>
        vscode.postMessage({ type: "openFile", path: w.path });
      body.appendChild(changed);
    } else {
      const normalized = w.kind
        ? w
        : {
            kind: "task",
            text: w.name || "Reconnecting " + w.attempt + "/" + w.max,
            done: w.done ?? w.ok,
          };
      body.appendChild(buildWorkNode(normalized));
    }
  }
  return det;
}
function appendTranscriptFlow(turn, item, work) {
  const entries = (work || []).filter((w) => w.kind !== "plan");
  const groups = [];
  for (const entry of entries) {
    const offset = Math.max(
      0,
      Math.min(
        item.text.length,
        Number.isFinite(entry.answerOffset) ? entry.answerOffset : 0,
      ),
    );
    const last = groups[groups.length - 1];
    if (last && last.offset === offset) last.entries.push(entry);
    else groups.push({ offset, entries: [entry] });
  }
  let cursor = 0;
  for (const group of groups) {
    if (group.offset > cursor)
      turn.appendChild(
        assistantSegment(
          item.text.slice(cursor, group.offset),
          item.kind,
          false,
        ),
      );
    turn.appendChild(
      transcriptActivity(group.entries, item.seconds, groups.length === 1),
    );
    cursor = Math.max(cursor, group.offset);
  }
  if (cursor < item.text.length || !entries.length)
    turn.appendChild(
      assistantSegment(item.text.slice(cursor), item.kind, false),
    );
}
function diffReviewBox(item) {
  const files = item.editedFiles || [];
  const box = document.createElement("div");
  box.className = "diff-review" + (item.undone ? " undone" : "");
  const bar = document.createElement("div");
  bar.className = "diff-review-bar";
  const head = document.createElement("button");
  head.className = "diff-review-head";
  head.type = "button";
  head.setAttribute("aria-expanded", "true");
  head.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/></svg> Edited ' +
    files.length +
    " file" +
    (files.length === 1 ? "" : "s");
  head.onclick = () => {
    const collapsed = box.classList.toggle("collapsed");
    head.setAttribute("aria-expanded", String(!collapsed));
  };
  bar.appendChild(head);
  if (item.undoId) {
    const undo = document.createElement("button");
    undo.className = "diff-undo";
    undo.type = "button";
    undo.disabled = Boolean(item.undone);
    undo.title = item.undone ? "Changes already undone" : "Undo these changes";
    undo.setAttribute(
      "aria-label",
      item.undone
        ? "Changes already undone"
        : "Undo changes from this response",
    );
    undo.innerHTML = item.undone
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg> Undone'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"/><path d="M20 17a7 7 0 0 0-7-7H4"/></svg> Undo';
    undo.onclick = () =>
      vscode.postMessage({
        type: "undoChanges",
        conversationId: activeConversationId,
        itemId: item.id,
      });
    bar.appendChild(undo);
  }
  const list = document.createElement("div");
  list.className = "diff-review-list";
  for (const f of files) {
    const row = document.createElement("button");
    row.className =
      "diff-review-file" + (f.action === "Deleted" ? " deleted" : "");
    row.type = "button";
    row.disabled = Boolean(item.undone);
    if (item.undone) row.title = "These changes have been undone";
    const stats =
      f.action === "Deleted"
        ? '<span class="diff-stat removed">-' + (f.removed || 0) + "</span>"
        : '<span class="diff-stat added">+' +
          (f.added || 0) +
          '</span><span class="diff-stat removed">-' +
          (f.removed || 0) +
          "</span>";
    row.innerHTML =
      '<span class="diff-review-name">' +
      esc(f.path) +
      '</span><span class="diff-review-stats">' +
      stats +
      "</span>";
    row.onclick = () =>
      vscode.postMessage({
        type: "reviewDiff",
        conversationId: activeConversationId,
        itemId: item.id,
        path: f.path,
      });
    list.appendChild(row);
  }
  box.appendChild(bar);
  box.appendChild(list);
  return box;
}
function renderConversation(items) {
  messages.innerHTML = items && items.length ? "" : emptyState();
  hidePlan();
  currentTurn = current = activity = activityBody = null;
  reasoningNode = null;
  reasoningSegRef = null;
  lastReasonNode = null;
  bindRecent(messages);
  for (let i = 0; i < (items || []).length; i++) {
    const item = items[i];
    if (item.role === "user") {
      const turn = document.createElement("section");
      turn.className = "turn";
      turn.appendChild(userBubble(item));
      const next = items[i + 1];
      if (next && next.role === "assistant") {
        const work = next.work || [];
        for (const p of work.filter((w) => w.kind === "plan")) {
          const steps = p.steps || [];
          const allDone =
            (p.doneSteps || []).length >= steps.length && steps.length > 0;
          turn.appendChild(
            planCard(
              p.title || "Plan",
              steps,
              allDone ? -1 : (p.activeStep ?? -1),
              p.doneSteps || [],
              Boolean(p.interrupted),
            ),
          );
        }
        appendTranscriptFlow(turn, next, work);
        turn.appendChild(messageFooter(next, true));
        if (next.editedFiles && next.editedFiles.length)
          turn.appendChild(diffReviewBox(next));
        i++;
      }
      messages.appendChild(turn);
    }
  }
  followOutput = true;
  scroll(true);
}
function enableActivity() {
  if (activity) activity.classList.add("has-content");
}
function updateTask(m) {
  mountActivity();
  if (!currentTurn || !activityBody) return;
  lastReasonNode = null;
  let row = [...activityBody.querySelectorAll("[data-task]")].find(
    (el) => el.dataset.task === m.id,
  );
  if (!row) {
    row = document.createElement("div");
    row.className = "tool";
    row.dataset.task = m.id;
    row.innerHTML =
      '<span class="task-state"></span><div class="task-label"></div>';
    activityBody.appendChild(row);
    taskCount++;
  }
  row.querySelector(".task-label").innerHTML = markdown(m.name);
  if (m.phase === "end") row.classList.add("done");
  enableActivity();
  scrollActivity();
}
function showRetry(m) {
  if (!currentTurn) ensureTurn();
  if (currentTurn)
    currentTurn
      .querySelectorAll(".retry:not(.done):not(.failed)")
      .forEach((row) => row.classList.add("done"));
  mountActivity();
  if (!currentTurn) return;
  const row = document.createElement("div");
  row.className = "tool retry";
  row.dataset.retry = String(m.attempt);
  row.innerHTML =
    '<span class="task-state"></span><div class="task-label">' +
    markdown("**Reconnecting " + m.attempt + "/" + m.max + "**") +
    "</div>";
  activityBody.appendChild(row);
  taskCount++;
  enableActivity();
  lastReasonNode = null;
  scrollActivity();
}
function finishRetry(m) {
  const rows = currentTurn?.querySelectorAll(".retry");
  if (!rows?.length) return;
  const last = rows[rows.length - 1];
  last.classList.add(m.ok ? "done" : "failed");
  last.querySelector(".task-label").innerHTML = markdown(
    m.ok
      ? "**Reconnected " + m.attempt + "/" + m.max + "**"
      : "**Reconnect failed " + m.attempt + "/" + m.max + "**",
  );
  scrollActivity();
}
function finishActivity() {
  if (!activity || !activityBody) return;
  const hasWork = activityBody.querySelector(".tool,.changed,.retry");
  const hasReason = activityBody.querySelector(".reasoning");
  if (!hasWork && !hasReason) return;
  activity.classList.remove("loading");
  const seconds = Math.max(1, Math.round((Date.now() - phaseStartedAt) / 1000));
  activity.querySelector("summary").textContent = hasWork
    ? "Worked for " +
      seconds +
      "s" +
      (taskCount
        ? " · " + taskCount + " task" + (taskCount === 1 ? "" : "s")
        : "")
    : "Thought for " + seconds + "s";
  activity.open = false;
}
function nextWorkPhase() {
  closeCurrentText();
  scroll();
}
function finish(item) {
  closeCurrentText();
  endReasoningSegment();
  if (currentTurn) {
    if (activity) finishActivity();
    hidePlan();
    if (item) {
      if (!currentTurn.querySelector(".assistant"))
        currentTurn.appendChild(assistantSegment(item.text, item.kind, false));
      const oldFooter = currentTurn.querySelector(".message-footer");
      if (oldFooter) oldFooter.remove();
      currentTurn.appendChild(messageFooter(item, true));
      if (
        item.editedFiles &&
        item.editedFiles.length &&
        !currentTurn.querySelector(".diff-review")
      )
        currentTurn.appendChild(diffReviewBox(item));
    }
  }
  currentTurn = current = activity = activityBody = null;
  reasoningNode = reasoningSegRef = lastReasonNode = null;
  scroll();
}
function renderConversationMenu() {
  const active = conversations.filter((x) => !x.archived),
    archived = conversations.filter((x) => x.archived);
  const group = (label, items) =>
    items.length
      ? '<div class="menu-label">' +
        label +
        "</div>" +
        items
          .map(
            (x) =>
              '<div class="conversation-row ' +
              (x.id === activeConversationId ? "active" : "") +
              '" data-open="' +
              esc(x.id) +
              '">' +
              (x.running ? '<span class="spinner"></span>' : "") +
              '<span class="title">' +
              esc(x.title) +
              '</span><button class="archive-action" data-archive="' +
              esc(x.id) +
              '" title="' +
              (x.archived ? "Restore" : "Archive") +
              '">' +
              (x.archived
                ? '<svg viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>'
                : '<svg viewBox="0 0 24 24"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>') +
              '</button><button class="archive-action delete-action" data-delete="' +
              esc(x.id) +
              '" title="' +
              (x.archived ? "Delete permanently" : "Delete chat") +
              '">×</button></div>',
          )
          .join("")
      : "";
  conversationMenu.innerHTML =
    group("Conversations", active) + group("Archived", archived);
  conversationMenu.querySelectorAll("[data-open]").forEach(
    (el) =>
      (el.onclick = () => {
        vscode.postMessage({ type: "openConversation", id: el.dataset.open });
        conversationMenu.classList.remove("open");
      }),
  );
  conversationMenu.querySelectorAll("[data-archive]").forEach(
    (el) =>
      (el.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: "archiveConversation",
          id: el.dataset.archive,
        });
      }),
  );
  conversationMenu.querySelectorAll("[data-delete]").forEach(
    (el) =>
      (el.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: "deleteConversation",
          id: el.dataset.delete,
        });
      }),
  );
}
function retryButton() {
  const btn = document.createElement("button");
  btn.className = "retry-btn";
  btn.title = "Continue from where it stopped";
  btn.setAttribute("aria-label", "Continue the last request");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.5L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.5L3 16"/><path d="M3 21v-5h5"/></svg> Continue';
  btn.onclick = () =>
    vscode.postMessage({
      type: "retryMessage",
      conversationId: activeConversationId,
    });
  return btn;
}
function errorActions() {
  const actions = document.createElement("div");
  actions.className = "error-actions";
  actions.appendChild(retryButton());
  return actions;
}
function addError(text, retry) {
  document.getElementById("empty")?.remove();
  const d = document.createElement("div");
  d.className = "error";
  d.textContent = text;
  if (retry) d.appendChild(errorActions());
  messages.appendChild(d);
  scroll();
}
function showGenerationError(item) {
  if (!current && currentTurn) createTextSegment();
  if (current) {
    current.className = "assistant error-card";
    current.dataset.raw = "";
    current.textContent = item.text;
    current.appendChild(errorActions());
  } else addError(item.text, true);
  finish(item);
}
function updateSendMode() {
  const stopping = isRunning() && !input.value.trim();
  send.classList.toggle("stop", stopping);
  send.title = stopping ? "Stop" : "Send";
}
function renderModelMenu() {
  modelMenu.innerHTML = "";
  if (!modelGroups.length) {
    const empty = document.createElement("div");
    empty.className = "dropdown-empty";
    empty.textContent = "No models available yet.";
    modelMenu.appendChild(empty);
    return;
  }
  for (const group of modelGroups) {
    const label = document.createElement("div");
    label.className = "dropdown-group-label";
    label.textContent = group.providerName;
    modelMenu.appendChild(label);
    for (const id of group.models) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className =
        "dropdown-option" + (id === selectedModel ? " selected" : "");
      opt.textContent = displayModel(id);
      opt.title = id;
      opt.onclick = () => selectModel(id, group.providerId);
      modelMenu.appendChild(opt);
    }
  }
}
function closeModelMenu() {
  modelMenu.classList.remove("open");
}
function toggleModelMenu() {
  modelMenu.classList.toggle("open");
  if (modelMenu.classList.contains("open")) renderModelMenu();
}
function selectModel(id, providerId) {
  selectedModel = id;
  modelButton.textContent = displayModel(id);
  modelButton.title = id;
  closeModelMenu();
  vscode.postMessage({ type: "selectModel", model: id, provider: providerId });
}
let editingMessage = null;
function updateEditingBanner() {
  const banner = document.getElementById("editingBanner");
  if (banner) banner.classList.toggle("visible", Boolean(editingMessage));
}
function startEditMessage(item) {
  if (isRunning()) return;
  editingMessage = { conversationId: activeConversationId, itemId: item.id };
  input.value = item.text;
  resize();
  updateEditingBanner();
  input.focus();
}
function cancelEditMessage() {
  editingMessage = null;
  input.value = "";
  resize();
  updateEditingBanner();
}
function submit() {
  const text = input.value.trim();
  if (isRunning()) {
    if (!text) {
      vscode.postMessage({ type: "stop" });
      return;
    }
  }
  if (!text) return;
  if (!selectedModel) {
    addError("Choose a model first.");
    return;
  }
  if (editingMessage) {
    const em = editingMessage;
    editingMessage = null;
    updateEditingBanner();
    input.value = "";
    contextAttachments = [];
    renderContext();
    resize();
    vscode.postMessage({
      type: "editMessage",
      conversationId: em.conversationId,
      itemId: em.itemId,
      text,
    });
    return;
  }
  const context = {
    includeActiveFile: true,
    includeSelection,
    activeFile: editorContext.activeFile,
    selectionLines: editorContext.selectionLines,
    attachments: [...contextAttachments],
  };
  input.value = "";
  contextAttachments = [];
  renderContext();
  resize();
  vscode.postMessage({
    type: "send",
    text,
    conversationId: activeConversationId,
    context,
  });
}
function resize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
  updateSendMode();
  if (followOutput) pinScroll();
}
send.onclick = submit;
input.oninput = resize;
input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
};
messages.addEventListener("scroll", () => {
  followOutput = nearBottom();
  updateJump();
});
jumpBottom.onclick = () => {
  followOutput = true;
  scroll(true);
};
projectIndicator.onclick = () => {
  if (projectIndicatorPath) vscode.postMessage({ type: "revealInOS" });
};
document.getElementById("steerQueued").onclick = () =>
  vscode.postMessage({
    type: "steerQueued",
    conversationId: activeConversationId,
  });
document.getElementById("cancelEdit").onclick = cancelEditMessage;
document.getElementById("editQueued").onclick = () => {
  const prompt = queuedByConversation.get(activeConversationId);
  if (!prompt) return;
  queuedByConversation.delete(activeConversationId);
  updateQueuedVisibility();
  vscode.postMessage({
    type: "removeQueued",
    conversationId: activeConversationId,
  });
  input.value = prompt;
  resize();
  input.focus();
};
document.getElementById("removeQueued").onclick = () =>
  vscode.postMessage({
    type: "removeQueued",
    conversationId: activeConversationId,
  });
const settingsView = document.getElementById("settingsView"),
  maxSteps = document.getElementById("maxSteps"),
  maxStepsUnlimited = document.getElementById("maxStepsUnlimited"),
  approvalMode = document.getElementById("approvalMode"),
  searxngUrl = document.getElementById("searxngUrl"),
  systemPrompt = document.getElementById("systemPrompt"),
  extraFreeModels = document.getElementById("extraFreeModels"),
  settingsResult = document.getElementById("settingsResult"),
  provider = document.getElementById("provider"),
  apiKeyInput = document.getElementById("apiKey"),
  apiKeyField = document.getElementById("apiKeyField"),
  apiKeyHint = document.getElementById("apiKeyHint"),
  clearApiKey = document.getElementById("clearApiKey"),
  clearApiKeyRow = document.getElementById("clearApiKeyRow"),
  savedKeyLabel = document.getElementById("savedKeyLabel"),
  baseUrlInput = document.getElementById("baseUrl"),
  baseUrlField = document.getElementById("baseUrlField"),
  onlyDefaultModels = document.getElementById("onlyDefaultModels"),
  confirmDelete = document.getElementById("confirmDelete");

let initialSetup = false,
  savedApiKeys = {},
  providersList = [],
  providerConfigured = {},
  settingsSavedTimer = null;
const resetSettingsBtn = document.getElementById("resetSettings");
let resetClicks = 0,
  autosaveTimer = null;
function resetArmGuard() {
  resetClicks = 0;
  resetSettingsBtn.textContent = "Reset to defaults";
}
function settingsPayload() {
  return {
    maxSteps: maxStepsUnlimited.checked ? 0 : Number(maxSteps.value),
    approvalMode: approvalMode.value,
    searxngUrl: searxngUrl.value,
    systemPrompt: systemPrompt.value,
    extraFreeModels: extraFreeModels.value,
    provider: provider.value,
    apiKey: apiKeyInput.value,
    baseUrl: baseUrlInput.value,
    onlyDefaultModels: onlyDefaultModels.checked,
    confirmDelete: confirmDelete.checked,
    initialSetup,
  };
}
function autosaveNow() {
  resetArmGuard();
  clearTimeout(autosaveTimer);
  vscode.postMessage({ type: "saveSettings", ...settingsPayload() });
}
function autosaveLater() {
  resetArmGuard();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(
    () => vscode.postMessage({ type: "saveSettings", ...settingsPayload() }),
    350,
  );
}
function renderProviderOptions() {
  provider.innerHTML = (providersList || [])
    .map(
      (p) =>
        '<option value="' +
        esc(p.id) +
        '" data-accepts="' +
        p.acceptsApiKey +
        '" data-required="' +
        p.needsApiKey +
        '" data-name="' +
        esc(p.name) +
        '" data-url="' +
        esc(p.apiKeyUrl || "") +
        '" data-local="' +
        p.isLocal +
        '" data-baseurl="' +
        esc(p.baseUrl || "") +
        '">' +
        esc(p.name) +
        (providerConfigured[p.id] ? " - Configured" : "") +
        "</option>",
    )
    .join("");
}
function updateProviderFields() {
  const opt = provider.options[provider.selectedIndex];
  const accepts = opt?.dataset.accepts === "true";
  const has = Boolean(savedApiKeys[opt?.value]);
  apiKeyField.style.display = accepts ? "" : "none";
  baseUrlField.style.display = opt?.dataset.local === "true" ? "" : "none";
  if (opt?.dataset.local === "true")
    baseUrlInput.value = opt?.dataset.baseurl || "";
  if (!accepts) {
    apiKeyHint.textContent = "";
    return;
  }
  savedKeyLabel.textContent = has ? "Key saved" : "No key saved";
  clearApiKeyRow.style.display = has ? "flex" : "none";
  const keyUrl = opt?.dataset.url || "";
  const hint = apiKeyHint;
  if (providerConfigured[opt?.value] && has) {
    hint.textContent = "";
  } else if (keyUrl) {
    const label = esc(opt?.dataset.name || "this provider");
    const link =
      '<a href="' +
      esc(keyUrl) +
      '" target="_blank" rel="noopener">' +
      label +
      "</a>";
    hint.innerHTML =
      opt?.dataset.required === "true"
        ? "Get a free API key from " + link + "."
        : "(Optional - Get API Key from " + link + ")";
  } else {
    hint.textContent = "";
  }
}
function openSettings(m) {
  initialSetup = Boolean(m.initialSetup);
  savedApiKeys = m.apiKeys || {};
  providersList = m.providers || [];
  providerConfigured = m.configured || {};
  settingsView.classList.toggle("onboarding", initialSetup);
  document.getElementById("settingsTitle").textContent = initialSetup
    ? "Set up Opencodex"
    : "Opencodex Settings";
  renderProviderOptions();
  provider.value = m.provider || "opencode";
  maxSteps.value = m.maxSteps || 20;
  maxStepsUnlimited.checked = m.maxSteps === 0;
  maxSteps.disabled = maxStepsUnlimited.checked;
  onlyDefaultModels.checked = Boolean(m.onlyDefaultModels);
  confirmDelete.checked = m.confirmDelete !== false;
  approvalMode.value = m.approvalMode || "ask";
  searxngUrl.value = m.searxngUrl || "";
  systemPrompt.value = m.systemPrompt || "";
  extraFreeModels.value = m.extraFreeModels || "";
  apiKeyInput.value = "";
  updateProviderFields();
  settingsResult.textContent = "";
  settingsResult.className = "settings-result";
  document.querySelector(".app").style.display = "none";
  settingsView.classList.add("visible");
  resetArmGuard();
  clearTimeout(autosaveTimer);
  clearTimeout(settingsSavedTimer);
  vscode.postMessage({ type: "fetchMcpConnections" });
  setTimeout(() => maxSteps.focus(), 0);
}
function closeSettings() {
  settingsView.classList.remove("visible");
  document.querySelector(".app").style.display = "flex";
}
modelButton.onclick = toggleModelMenu;
document.addEventListener("click", (e) => {
  if (!modelDropdown.contains(e.target)) closeModelMenu();
});
document.getElementById("usageButton").onclick = openUsageView;
document.getElementById("usageBack").onclick = closeUsageView;
document.getElementById("usageRefresh").onclick = () =>
  vscode.postMessage({ type: "requestUsage" });
document.getElementById("marketplaceButton").onclick = () => {
  openMarketplaceView();
  vscode.postMessage({ type: "requestMarketplaceInstalled" });
};
document.getElementById("marketplaceBack").onclick = closeMarketplaceView;
document.getElementById("marketplaceRefresh").onclick = () => {
  if (marketplaceTab === "installed") {
    vscode.postMessage({ type: "requestMarketplaceInstalled" });
  } else if (marketplaceQuery.value.trim()) {
    marketplaceSearch();
  } else if (!marketplaceBusy) {
    loadMarketplaceTop(true, marketplaceSort.value);
  }
};
document.getElementById("marketplaceSearchBtn").onclick = marketplaceSearch;
marketplaceQuery.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    marketplaceSearch();
  }
};
marketplaceQuery.oninput = () => runMarketplaceSearch(true);
marketplaceSort.onchange = () => runMarketplaceSearch(false);
document.getElementById("marketplaceRepoBtn").onclick = marketplaceListRepo;
marketplaceRepo.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    marketplaceListRepo();
  }
};
document.getElementById("previewClose").onclick = closeSkillPreview;
previewModal.onclick = (e) => {
  if (e.target === previewModal) closeSkillPreview();
};
previewInstall.onclick = () => {
  if (!previewState) return;
  const path = previewState.path;
  startSkillInstall(
    previewState.origin === null || previewState.origin === undefined
      ? -1
      : previewState.origin,
    {
      install: {
        source: previewState.source,
        skill: path ? path.split("/").pop() : undefined,
      },
    },
  );
};
document.getElementById("settingsButton").onclick = () =>
  vscode.postMessage({ type: "requestSettings" });
document.getElementById("settingsBack").onclick = closeSettings;
document.getElementById("newConversation").onclick = () =>
  vscode.postMessage({ type: "newConversation" });
document.getElementById("conversationButton").onclick = () =>
  conversationMenu.classList.toggle("open");
resetSettingsBtn.onclick = () => {
  resetClicks++;
  if (resetClicks >= 3) {
    resetClicks = 0;
    resetSettingsBtn.textContent = "Reset to defaults";
    vscode.postMessage({ type: "resetSettings" });
    return;
  }
  resetSettingsBtn.textContent =
    resetClicks === 1
      ? "Click 2 more times to reset"
      : "Click 1 more time to reset";
};
maxStepsUnlimited.onchange = () => {
  maxSteps.disabled = maxStepsUnlimited.checked;
  autosaveNow();
};
maxSteps.oninput = autosaveLater;
provider.onchange = () => {
  updateProviderFields();
  autosaveNow();
};
onlyDefaultModels.onchange = autosaveNow;
confirmDelete.onchange = autosaveNow;
approvalMode.onchange = autosaveNow;
searxngUrl.oninput = autosaveLater;
systemPrompt.oninput = autosaveLater;
extraFreeModels.oninput = autosaveLater;
apiKeyInput.oninput = autosaveLater;
baseUrlInput.oninput = autosaveLater;
clearApiKey.onclick = () => {
  clearApiKey.disabled = true;
  vscode.postMessage({ type: "removeApiKey", provider: provider.value });
};
window.addEventListener("message", async ({ data: m }) => {
  switch (m.type) {
    case "editorContext":
      editorContext = {
        activeFile: m.activeFile || "",
        hasSelection: Boolean(m.hasSelection),
        selectionLines: m.selectionLines || "",
      };
      renderContext();
      renderProjectIndicator();
      break;
    case "contextAttachments":
      contextAttachments.push(
        ...(m.attachments || []).filter(
          (item) =>
            !contextAttachments.some(
              (existing) =>
                existing.kind === item.kind && existing.path === item.path,
            ),
        ),
      );
      renderContext();
      break;
    case "project": {
      projectIndicatorFolder = m.name || "No folder open";
      projectIndicatorPath = m.path || "";
      projectIndicator.classList.toggle(
        "clickable",
        Boolean(projectIndicatorPath),
      );
      renderProjectIndicator();
      break;
    }
    case "browserPreview": {
      latestBrowserPreview = m.preview || null;
      if (!latestBrowserPreview) {
        document
          .querySelectorAll(".browser-thumb")
          .forEach((el) => el.remove());
        closeBrowserViewer();
        break;
      }
      if (!activityBody && currentTurn) {
        ensureActivity();
        enableActivity();
      }
      scrollActivity();
      if (browserViewerBackdrop.classList.contains("open"))
        applyBrowserPreview(
          browserViewerImage,
          browserViewerCursor,
          latestBrowserPreview,
        );
      break;
    }
    case "conversations":
      conversations = m.conversations || [];
      activeConversationId = m.activeId;
      conversationTitle.textContent =
        conversations.find((x) => x.id === activeConversationId)?.title ||
        "New conversation";
      runningSet = new Set(
        conversations.filter((x) => x.running).map((x) => x.id),
      );
      queuedByConversation = new Map(
        conversations.map((x) => [x.id, x.queued || null]),
      );
      renderConversationMenu();
      refreshEmpty();
      updateQueuedVisibility();
      modelButton.disabled = isRunning();
      updateSendMode();
      updateJump();
      break;
    case "conversation":
      activeConversationId = m.id;
      cancelEditMessage();
      renderConversation(m.items);
      renderLive(m.id);
      updateQueuedVisibility();
      modelButton.disabled = isRunning();
      updateSendMode();
      updateJump();
      break;
    case "settings":
      openSettings(m);
      break;
    case "settingsResult": {
      if (m.ok && m.text === "Settings saved.") {
        initialSetup = false;
        settingsView.classList.remove("onboarding");
        if (apiKeyInput.value.trim()) {
          savedApiKeys[provider.value] = true;
          providerConfigured[provider.value] = true;
          renderProviderOptions();
        }
        updateProviderFields();
      }
      clearTimeout(settingsSavedTimer);
      if (m.ok) {
        settingsResult.className = "settings-result";
        void settingsResult.offsetWidth;
        settingsResult.textContent = "Saved";
        settingsResult.className = "settings-result ok";
        settingsSavedTimer = setTimeout(() => {
          settingsResult.textContent = "";
          settingsResult.className = "settings-result";
        }, 1800);
      } else {
        settingsResult.textContent = m.text;
        settingsResult.className = "settings-result bad";
      }
      break;
    }
    case "apiKeyState":
      savedApiKeys[m.provider] = m.hasApiKey;
      providerConfigured[m.provider] = Boolean(m.configured);
      clearApiKey.disabled = false;
      renderProviderOptions();
      updateProviderFields();
      break;
    case "config":
      if (m.model) {
        selectedModel = m.model;
        modelButton.textContent = displayModel(m.model);
      }
      if (m.approvalMode) approvalMode.value = m.approvalMode;
      break;
    case "models": {
      modelGroups = m.groups || [];
      selectedModel = m.selected || "";
      modelButton.textContent = selectedModel
        ? displayModel(selectedModel)
        : "Choose free model…";
      modelButton.title = selectedModel ? displayModel(selectedModel) : "";
      renderModelMenu();
      break;
    }
    case "modelsError":
      addError(m.text);
      break;
    case "showUsage":
      openUsageView();
      break;
    case "showMarketplace":
      openMarketplaceView();
      break;
    case "marketplaceInstalled":
      installedSkills = m.skills || [];
      renderInstalledSkills();
      if (marketplaceView.classList.contains("visible"))
        renderMarketplaceResults();
      break;
    case "marketplaceResults": {
      marketplaceBusy = false;
      marketplaceCards = (m.skills || []).map((x) => ({
        key: x.githubUrl || x.name,
        name: x.name,
        author: x.author || "",
        description: x.description || "",
        meta:
          (x.stars ? String(x.stars) + " ★" : "") +
          (x.author ? " · " + esc(x.author) : ""),
        installed: installedMatch(x.author, x.name),
      }));
      marketplaceActions = (m.skills || []).map((x) => ({
        preview: x.githubUrl ? { source: x.githubUrl, path: "" } : null,
        install: x.githubUrl ? { source: x.githubUrl, skill: undefined } : null,
      }));
      marketplaceStatusText(
        m.query
          ? "Found " +
              (m.total || (m.skills || []).length) +
              ' skills for "' +
              m.query +
              '".'
          : "Top skills (" + (m.skills || []).length + ").",
        true,
      );
      renderMarketplaceResults();
      break;
    }
    case "marketplaceRepoSkills": {
      marketplaceBusy = false;
      const source = m.owner + "/" + m.repo;
      marketplaceCards = (m.skills || []).map((x) => ({
        key: source + "/" + x.path,
        name: x.name,
        author: source,
        description: "",
        meta: "from " + esc(source),
        installed: installedMatch(source, x.name),
      }));
      marketplaceActions = (m.skills || []).map((x) => ({
        preview: { source, path: x.path },
        install: { source, skill: x.name },
      }));
      marketplaceStatusText(
        (m.skills || []).length + " skills in " + source + ".",
        true,
      );
      renderMarketplaceResults();
      break;
    }
    case "marketplacePreview": {
      previewContent.innerHTML = markdown(m.markdown || "");
      previewInstall.style.display = "";
      document.getElementById("previewTitle").textContent =
        m.title || "Skill preview";
      break;
    }
    case "marketplaceInstallProgress": {
      const st = marketplaceInstalling[m.key];
      if (st) {
        st.done = m.done || 0;
        st.total = m.total || 0;
        st.label =
          "Installing… " + (m.done || 0) + "/" + (m.total || 0) + " files";
        updateCardProgress(m.key);
        updatePreviewProgress(m.key);
      }
      break;
    }
    case "marketplaceResult": {
      if (m.key) delete marketplaceInstalling[m.key];
      marketplaceStatusText(m.text, !!m.ok);
      if (m.ok) {
        if (previewState && previewState.key === m.key) {
          closeSkillPreview();
        }
        if (marketplaceView.classList.contains("visible"))
          vscode.postMessage({ type: "requestMarketplaceInstalled" });
      } else {
        if (previewState && previewState.key === m.key) {
          previewProgress.classList.add("visible", "error");
          previewProgressFill.style.width = "100%";
          previewProgressLabel.textContent = m.text || "Install failed.";
        }
        renderMarketplaceResults();
      }
      break;
    }
    case "marketplaceError": {
      marketplaceBusy = false;
      marketplaceStatusText(m.text || "Request failed.", false);
      renderMarketplaceResults();
      break;
    }
    case "usage":
      usageData = m;
      if (usageView.classList.contains("visible")) renderUsage();
      break;
    case "liveUsage": {
      if (m.conversationId && (m.model || m.inputTokens || m.outputTokens)) {
        liveRuns.set(m.conversationId, {
          model: m.model,
          provider: m.provider,
          input: m.inputTokens || 0,
          output: m.outputTokens || 0,
        });
      } else {
        liveRuns.delete(m.conversationId);
      }
      if (usageView.classList.contains("visible")) renderUsage();
      break;
    }
    case "user": {
      liveByConversation.set(m.conversationId, freshLive());
      if (m.conversationId === activeConversationId) beginTurn(m.item);
      break;
    }
    case "resume": {
      const s = liveState(m.conversationId);
      s.phase = "thinking";
      s.reasoning = "";
      s.work = [];
      s.currentRaw = "";
      if (m.conversationId === activeConversationId) {
        currentTurn = document.querySelector(".turn:last-child") || null;
        current = null;
        activity = null;
        activityBody = null;
        reasoningNode = null;
        reasoningSegRef = null;
        lastReasonNode = null;
        if (currentTurn)
          currentTurn
            .querySelectorAll(".message-footer,.activity,.diff-review")
            .forEach((el) => el.remove());
        followOutput = true;
        scroll(true);
      }
      break;
    }
    case "workPhase": {
      const s = liveState(m.conversationId);
      s.phase = "work";
      if (m.conversationId === activeConversationId) nextWorkPhase();
      break;
    }
    case "delta": {
      const s = liveState(m.conversationId);
      s.currentRaw += m.text;
      s.phase = "text";
      s.reasoning = "";
      if (m.conversationId === activeConversationId && currentTurn) {
        endReasoningSegment();
        if (!current) createTextSegment();
        current.dataset.raw += m.text;
        current.innerHTML = markdown(current.dataset.raw);
        scroll();
      }
      break;
    }
    case "reasoning": {
      const s = liveState(m.conversationId);
      let seg = s.work[s.work.length - 1];
      if (
        seg &&
        seg.t === "reasoning" &&
        seg.answerOffset === s.currentRaw.length
      )
        seg.text += m.text;
      else {
        seg = {
          t: "reasoning",
          text: m.text,
          answerOffset: s.currentRaw.length,
        };
        s.work.push(seg);
      }
      s.reasoning += m.text;
      if (m.conversationId === activeConversationId) renderReasoning(seg);
      break;
    }
    case "plan": {
      const s = liveState(m.conversationId);
      s.plan = {
        title: m.title,
        steps: m.steps,
        activeStep: m.activeStep,
        doneSteps: m.doneSteps,
        interrupted: Boolean(m.interrupted),
        done: Boolean(m.done),
      };
      if (m.conversationId === activeConversationId) showPlan(m);
      break;
    }
    case "tool": {
      const s = liveState(m.conversationId);
      let row = s.work.find((e) => e.t === "tool" && e.id === m.id);
      if (row) {
        row.name = m.name;
        row.done = m.phase === "end";
      } else {
        s.work.push({
          t: "tool",
          id: m.id,
          name: m.name,
          done: m.phase === "end",
          answerOffset: s.currentRaw.length,
        });
        s.taskCount++;
      }
      if (m.conversationId === activeConversationId) updateTask(m);
      break;
    }
    case "retry": {
      const s = liveState(m.conversationId);
      s.work.push({
        t: "retry",
        attempt: m.attempt,
        max: m.max,
        ok: null,
        answerOffset: s.currentRaw.length,
      });
      s.taskCount++;
      if (m.conversationId === activeConversationId) showRetry(m);
      break;
    }
    case "retryEnd": {
      const s = liveState(m.conversationId);
      if (s.work.length) {
        const last = s.work[s.work.length - 1];
        if (last && last.t === "retry") last.ok = Boolean(m.ok);
      }
      if (m.conversationId === activeConversationId) finishRetry(m);
      break;
    }
    case "changed": {
      const s = liveState(m.conversationId);
      s.work.push({
        t: "changed",
        text: (m.action || "Changed") + " " + m.path,
        path: m.path,
        answerOffset: s.currentRaw.length,
      });
      if (m.conversationId === activeConversationId) {
        if (!currentTurn) break;
        mountActivity();
        const d = document.createElement("div");
        d.className = "changed";
        d.textContent = (m.action || "Changed") + " " + m.path;
        d.onclick = () =>
          vscode.postMessage({ type: "openFile", path: m.path });
        activityBody.appendChild(d);
        enableActivity();
        lastReasonNode = null;
        scrollActivity();
      }
      break;
    }
    case "command":
      break;
    case "error": {
      if (m.conversationId) {
        const s = liveState(m.conversationId);
        s.errorText = m.text;
        s.errorRetry = false;
        s.phase = "error";
        if (m.conversationId === activeConversationId) {
          addError(m.text);
          finish();
        }
      } else {
        addError(m.text);
        finish();
      }
      break;
    }
    case "steered":
      if (m.conversationId === activeConversationId) finish();
      break;
    case "generationError":
      liveByConversation.delete(m.conversationId);
      if (m.conversationId === activeConversationId)
        showGenerationError(m.item);
      break;
    case "queuedPrompt":
      if (m.prompt) queuedByConversation.set(m.conversationId, m.prompt);
      else queuedByConversation.delete(m.conversationId);
      updateQueuedVisibility();
      break;
    case "state":
      if (m.running) runningSet.add(m.conversationId);
      else runningSet.delete(m.conversationId);
      modelButton.disabled = isRunning();
      updateSendMode();
      updateJump();
      break;
    case "notify": {
      const choice = await showNotifyModal({
        title: m.title,
        body: m.detail,
        ok: m.okLabel,
        cancel: m.cancelLabel,
        secondary: m.secondaryLabel,
        danger: Boolean(m.danger),
      });
      vscode.postMessage({ type: "notifyResponse", id: m.id, choice });
      break;
    }
    case "done":
      liveByConversation.delete(m.conversationId);
      if (m.conversationId === activeConversationId) finish(m.item);
      break;
  }
});
(function () {
  const addMcpBackdrop = document.getElementById("addMcpBackdrop");
  const mcpTitleEl = document.getElementById("addMcpTitle");
  const mcpName = document.getElementById("mcpName");
  const mcpDescription = document.getElementById("mcpDescription");
  const mcpUrl = document.getElementById("mcpUrl");
  const mcpTransport = document.getElementById("mcpTransport");
  const mcpUrlLabel = document.getElementById("mcpUrlLabel");
  const mcpAuthType = document.getElementById("mcpAuthType");
  const mcpAuthFields = document.getElementById("mcpAuthFields");
  const mcpSave = document.getElementById("mcpSave");
  const mcpTestResult = document.getElementById("mcpTestResult");
  const addMcpClose = document.getElementById("addMcpClose");
  const addMcpCancel = document.getElementById("addMcpCancel");
  const mcpMode = document.getElementById("mcpMode");
  const oauthAdvanced = document.getElementById("oauthAdvanced");
  const g = (id) => document.getElementById(id);
  let editingConnection = null;
  let selectedMode = "url";
  let lastProbedUrl = "";

  function updateCreateState() {
    if (mcpSave)
      mcpSave.disabled = !(
        (mcpName?.value || "").trim() && (mcpUrl?.value || "").trim()
      );
  }

  function setMode(mode) {
    selectedMode = mode;
    if (mcpMode)
      mcpMode
        .querySelectorAll(".seg")
        .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    if (mcpUrlLabel)
      mcpUrlLabel.textContent = mode === "tunnel" ? "Tunnel URL" : "Server URL";
    if (mcpUrl)
      mcpUrl.placeholder =
        mode === "tunnel"
          ? "https://tunnel.example.dev/mcp"
          : "https://example.com/mcp";
  }

  function setOauthCard() {
    if (!oauthAdvanced) return;
    const show = (mcpAuthType?.value || "none") === "oauth2";
    oauthAdvanced.classList.toggle("hidden", !show);
  }

  function renderAuthFields(auth) {
    if (!mcpAuthFields) return;
    const type = mcpAuthType?.value || "none";
    setOauthCard();
    mcpAuthFields.innerHTML = "";
    if (type === "bearer") {
      mcpAuthFields.innerHTML =
        '<div class="field"><label for="authBearerToken">Bearer token</label><input id="authBearerToken" type="password" placeholder="token"></div>';
      if (auth && auth.token) g("authBearerToken").value = auth.token;
    } else if (type === "basic") {
      mcpAuthFields.innerHTML =
        '<div class="field"><label for="authBasicUser">Username</label><input id="authBasicUser" type="text"><label for="authBasicPass">Password</label><input id="authBasicPass" type="password"></div>';
      if (auth) {
        if (auth.username) g("authBasicUser").value = auth.username;
        if (auth.password) g("authBasicPass").value = auth.password;
      }
    } else if (type === "api-key") {
      mcpAuthFields.innerHTML =
        '<div class="field"><label for="authApiKey">API key</label><input id="authApiKey" type="password" placeholder="api key"></div>';
      if (auth && auth.apiKey) g("authApiKey").value = auth.apiKey;
    } else if (type === "header" || type === "custom") {
      mcpAuthFields.innerHTML =
        '<div class="field"><label for="authHeaders">Headers (JSON)</label><textarea id="authHeaders" rows="4" placeholder="{\"Authorization\":\"Bearer ...\"}"></textarea><p class="field-hint">Enter JSON object of header names to values.</p></div>';
      if (auth && (auth.customHeaders || auth.custom_headers || auth.custom)) {
        const h = auth.customHeaders || auth.custom_headers || auth.custom;
        try {
          g("authHeaders").value = JSON.stringify(h, null, 2);
        } catch (e) {
          g("authHeaders").value = String(h);
        }
      }
    }
  }

  function fillOauth(auth) {
    const c = auth && auth.oauth2Config;
    if (g("authOauthTokenUrl"))
      g("authOauthTokenUrl").value = (c && c.tokenUrl) || "";
    if (g("authOauthAuthUrl"))
      g("authOauthAuthUrl").value = (c && c.authUrl) || "";
    if (g("authOauthClientId"))
      g("authOauthClientId").value = (c && c.clientId) || "";
    if (g("authOauthClientSecret"))
      g("authOauthClientSecret").value = (c && c.clientSecret) || "";
    if (g("authOauthTokenAuth"))
      g("authOauthTokenAuth").value =
        (c && c.tokenAuthMethod) || "client_secret_basic";
    if (g("authOauthScope")) g("authOauthScope").value = (c && c.scope) || "";
    if (g("authOauthRedirectUri"))
      g("authOauthRedirectUri").value = (c && c.redirectUri) || "";
  }

  function openAddMcp(conn) {
    editingConnection = conn || null;
    lastProbedUrl = "";
    if (mcpTitleEl)
      mcpTitleEl.textContent = conn ? "Edit Plugin" : "New Plugin";
    if (mcpSave) mcpSave.textContent = conn ? "Save" : "Create";
    if (addMcpBackdrop) {
      addMcpBackdrop.classList.add("open");
      addMcpBackdrop.style.display = "flex";
    }
    if (conn) {
      if (mcpName) mcpName.value = conn.name || "";
      if (mcpDescription) mcpDescription.value = conn.description || "";
      if (mcpUrl) mcpUrl.value = conn.url || "";
      if (mcpTransport) mcpTransport.value = conn.transport || "http";
      if (mcpAuthType) mcpAuthType.value = conn.auth?.type || "none";
      setMode(conn.mode === "tunnel" ? "tunnel" : "url");
      renderAuthFields(conn.auth);
      fillOauth(conn.auth || {});
      lastProbedUrl = conn.url || "";
    } else {
      if (mcpName) mcpName.value = "";
      if (mcpDescription) mcpDescription.value = "";
      if (mcpUrl) mcpUrl.value = "";
      if (mcpTransport) mcpTransport.value = "http";
      if (mcpAuthType) mcpAuthType.value = "none";
      setMode("url");
      renderAuthFields(null);
      fillOauth({});
    }
    if (mcpTestResult) {
      mcpTestResult.textContent = "";
      mcpTestResult.classList.remove("clickable");
      mcpTestResult.dataset.needsSignin = "0";
    }
    updateCreateState();
    setTimeout(() => {
      if (mcpName) mcpName.focus();
    }, 120);
  }

  function closeAddMcp() {
    if (addMcpBackdrop) {
      addMcpBackdrop.classList.remove("open");
      addMcpBackdrop.style.display = "";
    }
    editingConnection = null;
    if (mcpTestResult) {
      mcpTestResult.textContent = "";
      mcpTestResult.classList.remove("clickable");
      mcpTestResult.dataset.needsSignin = "0";
    }
  }

  function buildAuthObject() {
    const type = mcpAuthType?.value || "none";
    if (type === "none") return { type: "none" };
    if (type === "bearer")
      return {
        type: "bearer",
        token: (g("authBearerToken")?.value || "").trim(),
      };
    if (type === "basic")
      return {
        type: "basic",
        username: g("authBasicUser")?.value || "",
        password: g("authBasicPass")?.value || "",
      };
    if (type === "api-key")
      return { type: "api-key", apiKey: g("authApiKey")?.value || "" };
    if (type === "header" || type === "custom") {
      const raw = g("authHeaders")?.value || "";
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        return { type: type, customHeaders: parsed };
      } catch (e) {
        return { type: type, customHeaders: {} };
      }
    }
    if (type === "oauth2") {
      return {
        type: "oauth2",
        oauth2Config: {
          tokenUrl: (g("authOauthTokenUrl")?.value || "").trim(),
          authUrl: (g("authOauthAuthUrl")?.value || "").trim(),
          clientId: (g("authOauthClientId")?.value || "").trim(),
          clientSecret: (g("authOauthClientSecret")?.value || "").trim(),
          tokenAuthMethod:
            g("authOauthTokenAuth")?.value || "client_secret_basic",
          scope: (g("authOauthScope")?.value || "").trim(),
          redirectUri: (g("authOauthRedirectUri")?.value || "").trim(),
        },
      };
    }
    return { type: "none" };
  }

  function checkConnection() {
    const url = (mcpUrl?.value || "").trim();
    if (!url) return;
    lastProbedUrl = url;
    if (mcpTestResult) {
      mcpTestResult.textContent = "Checking connection...";
      mcpTestResult.classList.remove("clickable");
      mcpTestResult.dataset.needsSignin = "0";
    }
    vscode.postMessage({
      type: "testMcpConnection",
      name: (mcpName?.value || "").trim() || "MCP server",
      url,
      transport: mcpTransport?.value || "http",
      authType: mcpAuthType?.value || "none",
      auth: buildAuthObject(),
    });
  }
  if (addMcpClose) addMcpClose.onclick = closeAddMcp;
  if (addMcpCancel) addMcpCancel.onclick = closeAddMcp;
  if (addMcpBackdrop)
    addMcpBackdrop.onclick = (e) => {
      if (e.target === addMcpBackdrop) closeAddMcp();
    };
  if (mcpAuthType)
    mcpAuthType.onchange = () => {
      renderAuthFields(null);
      updateCreateState();
    };
  if (mcpName) mcpName.oninput = updateCreateState;
  if (mcpUrl) mcpUrl.oninput = updateCreateState;
  if (mcpTestResult)
    mcpTestResult.onclick = () => {
      if (mcpTestResult.dataset.needsSignin === "1") checkConnection();
    };
  if (mcpMode)
    mcpMode
      .querySelectorAll(".seg")
      .forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  if (mcpSave)
    mcpSave.onclick = () => {
      const name = (mcpName?.value || "").trim();
      const url = (mcpUrl?.value || "").trim();
      if (!name || !url) {
        updateCreateState();
        if (!name && mcpName) mcpName.focus();
        else if (mcpUrl) mcpUrl.focus();
        return;
      }
      const conn = {
        name,
        description: (mcpDescription?.value || "").trim(),
        url,
        transport: mcpTransport?.value || "http",
        auth: buildAuthObject(),
        enabled: editingConnection ? editingConnection.enabled !== false : true,
        order: editingConnection ? editingConnection.order : Date.now(),
      };
      if (selectedMode === "tunnel") conn.mode = "tunnel";
      vscode.postMessage({ type: "saveMcpConnection", connection: conn });
      if (
        (mcpAuthType?.value || "none") === "none" &&
        selectedMode !== "tunnel"
      )
        checkConnection();
    };

  window.addEventListener("message", ({ data: m }) => {
    if (!m) return;
    if (m.type === "showAddMcp") {
      openAddMcp(m.connection);
    } else if (m.type === "mcpConnectionTestResult") {
      if (m.discoveredOAuth) {
        if (mcpAuthType) mcpAuthType.value = "oauth2";
        renderAuthFields(null);
        fillOauth({ oauth2Config: m.discoveredOAuth });
        updateCreateState();
      }
      if (m.success) {
        if (mcpTestResult) {
          mcpTestResult.textContent =
            m.tools && m.tools.length
              ? "Connected - tools: " + m.tools.join(", ")
              : "Connected - no sign-in required.";
          mcpTestResult.classList.remove("clickable");
          mcpTestResult.dataset.needsSignin = "0";
        }
        const editedName = ((mcpName && mcpName.value) || "").trim();
        if (editedName) {
          mcpStatuses[editedName] = {
            name: editedName,
            state: "ok",
            toolCount: (m.toolDetails || []).length,
            tools: m.toolDetails || [],
          };
          renderList(mcpConns);
        }
      } else if (m.authorizationStarted) {
        if (mcpTestResult) {
          mcpTestResult.textContent =
            (m.error || "Sign-in window opened.") +
            " Click here if it did not open.";
          mcpTestResult.classList.add("clickable");
          mcpTestResult.dataset.needsSignin = "1";
        }
      } else {
        if (mcpTestResult) {
          mcpTestResult.textContent = "Error: " + (m.error || "Unknown");
          mcpTestResult.classList.remove("clickable");
          mcpTestResult.dataset.needsSignin = "0";
        }
      }
    } else if (m.type === "mcpConnectionSaved") {
      if (m.name) pendingMcpToggles.delete(m.name);
      closeAddMcp();
      if (!m.silent)
        vscode.postMessage({
          type: "nativeNotify",
          message: "MCP Connection saved",
          detail: "Saved " + (m.name || ""),
          kind: "info",
        });
    } else if (m.type === "mcpConnectionDeleted") {
      vscode.postMessage({
        type: "nativeNotify",
        message: "MCP Connection deleted",
        detail: "Deleted " + (m.name || ""),
        kind: "info",
      });
    }
  });

  const mcpPicker = document.getElementById("mcpPicker");
  const mcpAddBtn = document.getElementById("mcpAddSettings");
  let mcpConns = [];
  let mcpStatuses = {};
  const pendingMcpToggles = new Map();
  const mcpStatusLabel = {
    ok: "Connected",
    auth_required: "Sign-in required",
    error: "Connection error",
    checking: "Checking…",
    disabled: "Disabled",
  };
  function fetchConns() {
    vscode.postMessage({ type: "fetchMcpConnections" });
  }
  function renderList(conns) {
    if (!mcpPicker) return;
    mcpConns = (conns || []).map((c) =>
      pendingMcpToggles.has(c.name)
        ? { ...c, enabled: pendingMcpToggles.get(c.name) }
        : c,
    );
    if (!mcpConns.length) {
      mcpPicker.innerHTML =
        '<div class="mcp-empty">No MCP Connections yet.<br>Use + to add one.</div>';
      return;
    }
    mcpPicker.innerHTML = mcpConns
      .map((c) => {
        const st = mcpStatuses[c.name];
        const enabled = c.enabled !== false;
        const state = enabled ? (st ? st.state : "checking") : "disabled";
        const toolCount =
          st && typeof st.toolCount === "number"
            ? st.toolCount
            : st && st.tools
              ? st.tools.length
              : undefined;
        const toolsBtn =
          state === "ok" && toolCount
            ? '<button class="mcp-tools-btn" data-name="' +
              esc(c.name) +
              '" title="See what ' +
              esc(c.name) +
              ' exposes to the agent">' +
              toolCount +
              " tool" +
              (toolCount === 1 ? "" : "s") +
              "</button>"
            : "";
        const statusText = mcpStatusLabel[state] || "";
        const statusHtml =
          state === "auth_required"
            ? '<span class="mcp-signin" data-name="' +
              esc(c.name) +
              '" title="Click to sign in">' +
              statusText +
              "</span>"
            : statusText;
        return (
          '<div class="mcp-row" data-name="' +
          esc(c.name) +
          '"><button type="button" class="mcp-toggle' +
          (enabled ? " on" : "") +
          '" data-name="' +
          esc(c.name) +
          '" role="switch" aria-checked="' +
          enabled +
          '" aria-pressed="' +
          enabled +
          '" title="' +
          (enabled ? "Disable" : "Enable") +
          " " +
          esc(c.name) +
          '"></button><div class="meta"><div class="title">' +
          esc(c.name) +
          toolsBtn +
          "</div>" +
          (c.description
            ? '<div class="desc">' + esc(c.description) + "</div>"
            : "") +
          '<div class="desc">' +
          statusHtml +
          " · " +
          (c.auth?.type === "oauth2"
            ? "OAuth"
            : c.auth?.type === "none" || !c.auth
              ? "Auto"
              : c.auth.type) +
          " · " +
          (c.transport || "http").toUpperCase() +
          '</div></div><button class="archive-action delete-action" data-name="' +
          esc(c.name) +
          '" title="Delete plugin"><svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button></div>'
        );
      })
      .join("");
  }
  function checkConns() {
    vscode.postMessage({ type: "checkMcpConnections" });
  }
  function openMcpTools(name) {
    const st = mcpStatuses[name];
    const tools = (st && st.tools) || [];
    const toolsListEl = document.getElementById("mcpToolsList");
    const titleEl = document.getElementById("mcpToolsTitle");
    if (titleEl) titleEl.textContent = name + " tools";
    if (toolsListEl) {
      toolsListEl.innerHTML = tools.length
        ? tools
            .map(
              (t) =>
                '<div class="mcp-tool-row"><div class="mcp-tool-exposed">' +
                esc(t.exposedName) +
                '</div><div class="mcp-tool-raw">server tool: ' +
                esc(t.toolName) +
                "</div>" +
                (t.description
                  ? '<div class="mcp-tool-desc">' +
                    esc(t.description) +
                    "</div>"
                  : "") +
                "</div>",
            )
            .join("")
        : '<div class="mcp-tools-empty">No tools reported by this server.</div>';
    }
    const backdrop = document.getElementById("mcpToolsBackdrop");
    if (backdrop) {
      backdrop.classList.add("open");
      backdrop.style.display = "flex";
    }
  }
  function closeMcpTools() {
    const backdrop = document.getElementById("mcpToolsBackdrop");
    if (backdrop) {
      backdrop.classList.remove("open");
      backdrop.style.display = "";
    }
  }
  const mcpToolsClose = document.getElementById("mcpToolsClose");
  if (mcpToolsClose) mcpToolsClose.onclick = closeMcpTools;
  const mcpToolsBackdropEl = document.getElementById("mcpToolsBackdrop");
  if (mcpToolsBackdropEl)
    mcpToolsBackdropEl.onclick = (e) => {
      if (e.target === mcpToolsBackdropEl) closeMcpTools();
    };
  if (mcpAddBtn)
    mcpAddBtn.onclick = () => {
      openAddMcp(null);
      if (addMcpBackdrop) addMcpBackdrop.scrollTop = 0;
    };
  if (mcpPicker) {
    mcpPicker.addEventListener("click", (e) => {
      const signin = e.target.closest(".mcp-signin");
      if (signin) {
        e.stopPropagation();
        const name = signin.dataset.name;
        const conn = mcpConns.find((c) => c.name === name);
        if (conn) {
          signin.textContent = "Opening sign-in...";
          vscode.postMessage({
            type: "testMcpConnection",
            name: conn.name,
            url: conn.url,
            transport: conn.transport || "http",
            authType: (conn.auth && conn.auth.type) || "oauth2",
            auth: conn.auth || { type: "oauth2" },
          });
        }
        return;
      }
      const toolsBtn = e.target.closest(".mcp-tools-btn");
      if (toolsBtn) {
        e.stopPropagation();
        openMcpTools(toolsBtn.dataset.name);
        return;
      }
      const delBtn = e.target.closest(".delete-action");
      if (delBtn) {
        e.stopPropagation();
        const name = delBtn.dataset.name;
        showNotifyModal({
          title: "Delete MCP Connection?",
          body: 'Remove "' + name + '" from your saved plugins?',
          ok: "Delete",
          cancel: "Cancel",
          danger: true,
        }).then((choice) => {
          if (choice === "ok")
            vscode.postMessage({ type: "deleteMcpConnection", name });
        });
        return;
      }
      const toggle = e.target.closest(".mcp-toggle");
      if (toggle) {
        e.stopPropagation();
        const conn = mcpConns.find((c) => c.name === toggle.dataset.name);
        if (conn) {
          const nextEnabled = conn.enabled === false;
          conn.enabled = nextEnabled;
          pendingMcpToggles.set(conn.name, nextEnabled);
          mcpStatuses[conn.name] = {
            ...(mcpStatuses[conn.name] || { name: conn.name }),
            state: nextEnabled ? "checking" : "disabled",
          };
          renderList(mcpConns);
          vscode.postMessage({
            type: "saveMcpConnection",
            connection: { ...conn, enabled: nextEnabled },
            silent: true,
          });
          if (nextEnabled) vscode.postMessage({ type: "checkMcpConnections" });
          return;
        }
        return;
      }
      const row = e.target.closest(".mcp-row");
      if (row) {
        const name = row.dataset.name;
        const conn = mcpConns.find((c) => c.name === name);
        if (conn) {
          openAddMcp(conn);
          if (addMcpBackdrop) addMcpBackdrop.scrollTop = 0;
        }
      }
    });
  }
  window.addEventListener("message", ({ data: m }) => {
    if (!m) return;
    if (m.type === "mcpConnections") {
      renderList(m.connections || []);
      checkConns();
    } else if (m.type === "mcpConnectionStatuses") {
      mcpStatuses = {};
      (m.statuses || []).forEach((s) => {
        mcpStatuses[s.name] = s;
      });
      renderList(mcpConns);
    } else if (
      m.type === "mcpConnectionSaved" ||
      m.type === "mcpConnectionDeleted"
    ) {
      fetchConns();
    }
  });
})();

(function () {
  const backdrop = document.getElementById("customProviderBackdrop");
  const titleEl = document.getElementById("customProviderTitle");
  const nameInput = document.getElementById("customProviderName");
  const baseUrlInput = document.getElementById("customProviderBaseUrl");
  const needsKeyInput = document.getElementById("customProviderNeedsKey");
  const apiKeyInput = document.getElementById("customProviderApiKey");
  const apiKeyField = document.getElementById("customProviderApiKeyField");
  const keyHint = document.getElementById("customProviderKeyHint");
  const resultEl = document.getElementById("customProviderResult");
  const saveBtn = document.getElementById("customProviderSave");
  const deleteBtn = document.getElementById("customProviderDelete");
  const closeBtn = document.getElementById("customProviderClose");
  const cancelBtn = document.getElementById("customProviderCancel");
  const addBtn = document.getElementById("customProviderAdd");
  if (!backdrop) return;
  let editingId = "";
  function syncApiKeyVisibility() {
    if (apiKeyField)
      apiKeyField.style.display = needsKeyInput.checked ? "" : "none";
  }
  function openModal(p) {
    editingId = p ? p.id : "";
    titleEl.textContent = p ? "Edit custom provider" : "Add custom provider";
    nameInput.value = p ? p.name : "";
    baseUrlInput.value = p ? p.baseUrl : "";
    needsKeyInput.checked = Boolean(p && p.needsApiKey);
    apiKeyInput.value = "";
    keyHint.textContent =
      p && p.hasApiKey
        ? "A key is already saved for this provider. Leave blank to keep it."
        : "";
    resultEl.textContent = "";
    deleteBtn.style.display = p ? "" : "none";
    syncApiKeyVisibility();
    backdrop.classList.add("open");
    backdrop.style.display = "flex";
    setTimeout(() => nameInput.focus(), 50);
  }
  function closeModal() {
    backdrop.classList.remove("open");
    backdrop.style.display = "";
  }
  if (addBtn) addBtn.onclick = () => openModal(null);
  if (closeBtn) closeBtn.onclick = closeModal;
  if (cancelBtn) cancelBtn.onclick = closeModal;
  if (needsKeyInput) needsKeyInput.onchange = syncApiKeyVisibility;
  backdrop.onclick = (e) => {
    if (e.target === backdrop) closeModal();
  };
  if (saveBtn)
    saveBtn.onclick = () => {
      const name = nameInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      if (!name) {
        resultEl.textContent = "Name is required.";
        nameInput.focus();
        return;
      }
      if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
        resultEl.textContent = "Base URL must start with http:// or https://.";
        baseUrlInput.focus();
        return;
      }
      resultEl.textContent = "";
      vscode.postMessage({
        type: "saveCustomProvider",
        id: editingId || undefined,
        name,
        baseUrl,
        needsApiKey: needsKeyInput.checked,
        apiKey: apiKeyInput.value.trim() || undefined,
      });
    };
  if (deleteBtn)
    deleteBtn.onclick = () => {
      if (!editingId) return;
      showNotifyModal({
        title: "Delete custom provider?",
        body:
          'Remove "' +
          nameInput.value.trim() +
          '"? Its saved API key will also be removed.',
        ok: "Delete",
        cancel: "Cancel",
        danger: true,
      }).then((choice) => {
        if (choice === "ok")
          vscode.postMessage({ type: "deleteCustomProvider", id: editingId });
      });
    };
  window.addEventListener("message", ({ data: m }) => {
    if (!m) return;
    if (m.type === "customProviderSaved") {
      closeModal();
    } else if (m.type === "customProviderDeleted") {
      closeModal();
    } else if (m.type === "customProviderError") {
      resultEl.textContent = m.text || "Failed to save provider.";
    }
  });
})();

vscode.postMessage({ type: "ready" });
