(function(){
  "use strict";

  // =================================================================
  // FIREBASE CONFIG — paste your own project's config object here.
  // Get it from: Firebase Console → Project settings → General →
  // "Your apps" → Web app → SDK setup and configuration.
  // Leave the placeholder as-is to run in local-only (no sync) mode.
  // =================================================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBncAe5D5L41KZCBSfHb707t402g45s6m4",
  authDomain: "app-racetimer.firebaseapp.com",
  projectId: "app-racetimer",
  storageBucket: "app-racetimer.firebasestorage.app",
  messagingSenderId: "807387307953",
  appId: "1:807387307953:web:0751a821578e1eb254a790"
};
  // =================================================================

  let db = null, firebaseReady = false;
  try{
    if(window.firebase && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf("ВСТАВЬТЕ") === -1){
      firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      firebaseReady = true;
    }
  }catch(e){
    console.error("Firebase init failed", e);
  }

  const META_DOC = firebaseReady ? db.collection("racetimer_meta").doc("state") : null;
  const PARTICIPANTS_COL = firebaseReady ? db.collection("racetimer_participants") : null;
  let lastSyncedParticipants = {}; // id -> JSON snapshot, used to send only real changes
  let syncInitialized = false;

  function setSyncStatus(cls, title){
    const el = document.getElementById("syncStatus");
    if(!el) return;
    el.className = "sync-status " + cls;
    el.title = title;
  }

  // =================================================================
  // ROLES — change these passwords to your own. Anyone who knows a
  // password can unlock that role in the dropdown at the top of the
  // page. This is a simple deterrent, not real security — don't use
  // it to protect anything sensitive.
  // =================================================================
  const ROLE_PASSWORDS = {
    startJudge: "start",
    finishJudge: "finish",
    admin: "admin"
  };
  const ROLE_LABELS = {
    guest: "Пользователь",
    startJudge: "Судья старт",
    finishJudge: "Судья финиш",
    admin: "Главный судья"
  };
  const ROLE_PERMS = {
    guest:       { tabs: ["protocol"], actions: {} },
    startJudge:  { tabs: ["protocol","participants","start","oncourse"],
                   actions: { start:true, revertStart:true, dns:true, addParticipant:true, assignBib:true, setStartOrder:true } },
    finishJudge: { tabs: ["protocol","oncourse"],
                   actions: { finish:true, revertStart:true, dnf:true } },
    admin:       { tabs: ["protocol","participants","start","oncourse"], actions: { all:true } }
  };
  const ROLE_STORAGE_KEY = "racetimer_role_v1";
  let currentRole = "guest";
  try{
    const savedRole = localStorage.getItem(ROLE_STORAGE_KEY);
    if(savedRole && ROLE_PERMS[savedRole]) currentRole = savedRole;
  }catch(e){ /* ignore, default to guest */ }

  function setRole(role){
    currentRole = role;
    try{ localStorage.setItem(ROLE_STORAGE_KEY, role); }catch(e){ /* ignore */ }
  }

  function can(action){
    const perms = ROLE_PERMS[currentRole];
    if(!perms) return false;
    return !!(perms.actions.all || perms.actions[action]);
  }
  function tabAllowed(tabId){
    const perms = ROLE_PERMS[currentRole];
    return !!(perms && perms.tabs.indexOf(tabId) !== -1);
  }
  function isAdmin(){ return currentRole === "admin"; }

  function applyRoleUI(){
    // show/hide nav tab buttons the current role isn't allowed to see
    document.querySelectorAll("nav.tabs button[data-tab]").forEach(btn=>{
      const allowed = tabAllowed(btn.dataset.tab);
      btn.style.display = allowed ? "" : "none";
    });
    // if the currently active tab is no longer allowed, fall back to Протокол
    const activeBtn = document.querySelector("nav.tabs button.active");
    if(activeBtn && !tabAllowed(activeBtn.dataset.tab)){
      const fallback = document.querySelector('nav.tabs button[data-tab="protocol"]');
      document.querySelectorAll("nav.tabs button").forEach(b=>b.classList.toggle("active", b===fallback));
      document.querySelectorAll("section.tab").forEach(s=>s.classList.toggle("active", s.id === "tab-protocol"));
    }
    document.getElementById("roleSelect").value = currentRole;
    renderAll();
  }

  document.getElementById("roleSelect").addEventListener("change", (e)=>{
    const wanted = e.target.value;
    if(wanted === "guest" || wanted === currentRole){
      setRole(wanted);
      applyRoleUI();
      return;
    }
    const pass = prompt("Пароль для роли «" + ROLE_LABELS[wanted] + "»:");
    if(pass === null){ e.target.value = currentRole; return; }
    if(pass === ROLE_PASSWORDS[wanted]){
      setRole(wanted);
      showToast("Роль: " + ROLE_LABELS[wanted]);
      applyRoleUI();
    } else {
      alert("Неверный пароль");
      e.target.value = currentRole;
    }
  });

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  const STORAGE_KEY = "racetimer_state_v1";

  function defaultState(){
    return {
      settings: { intervalSec: 60, startMode: "auto" },
      participants: [], // {id,bib,name,category,gender,ageGroup,status,startTime,finishTime}
      countdown: { nextStartAt: null, tenSecFired: false, zeroFired: false },
      selectedNextIds: [],
      selectedAuto: true
    };
  }

  let state = loadState();

  function loadState(){
    if(firebaseReady){
      // real data arrives asynchronously via the realtime listeners below
      return defaultState();
    }
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const d = defaultState();
      return Object.assign(d, parsed, {
        settings: Object.assign(d.settings, parsed.settings||{}),
        countdown: Object.assign(d.countdown, parsed.countdown||{})
      });
    }catch(e){
      console.error("Failed to load state, starting fresh.", e);
      return defaultState();
    }
  }

  function saveState(){
    if(!firebaseReady){
      try{
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }catch(e){
        console.error("Failed to save state", e);
        showToast("Ошибка сохранения данных!");
      }
      return;
    }
    setSyncStatus("online", "Синхронизация…");
    const writes = [];
    writes.push(META_DOC.set({
      settings: state.settings,
      countdown: state.countdown,
      selectedNextIds: state.selectedNextIds,
      selectedAuto: state.selectedAuto
    }));
    const currentIds = new Set();
    state.participants.forEach(p=>{
      currentIds.add(p.id);
      const json = JSON.stringify(p);
      if(lastSyncedParticipants[p.id] !== json){
        writes.push(PARTICIPANTS_COL.doc(p.id).set(p));
        lastSyncedParticipants[p.id] = json;
      }
    });
    Object.keys(lastSyncedParticipants).forEach(id=>{
      if(!currentIds.has(id)){
        writes.push(PARTICIPANTS_COL.doc(id).delete());
        delete lastSyncedParticipants[id];
      }
    });
    Promise.all(writes).then(()=>{
      setSyncStatus("online", "Синхронизировано");
    }).catch(e=>{
      console.error("Firestore save failed", e);
      setSyncStatus("error", "Ошибка синхронизации — проверьте интернет");
      showToast("Не удалось сохранить в облако — проверьте интернет");
    });
  }

  function setupRealtimeSync(){
    if(!firebaseReady){
      setSyncStatus("offline", "Работает локально, без онлайн-синхронизации (Firebase не настроен)");
      const banner = document.getElementById("syncBanner");
      banner.style.display = "block";
      banner.innerHTML = "Онлайн-синхронизация не настроена — данные видны только на этом устройстве. " +
        "Чтобы включить общий доступ на нескольких устройствах, впишите свой Firebase config в начало файла со скриптом приложения.";
      return;
    }
    setSyncStatus("offline", "Подключение…");

    META_DOC.onSnapshot(function(snap){
      if(snap.exists){
        const data = snap.data();
        state.settings = Object.assign(state.settings, data.settings||{});
        state.countdown = Object.assign(state.countdown, data.countdown||{});
        state.selectedNextIds = data.selectedNextIds || [];
        state.selectedAuto = data.selectedAuto !== undefined ? data.selectedAuto : true;
        applyTheme();
      }
      setSyncStatus("online", "Онлайн — изменения видны всем устройствам");
      renderAll();
    }, function(err){
      console.error("meta snapshot error", err);
      setSyncStatus("error", "Ошибка подключения к базе — проверьте интернет и настройки доступа");
      showToast("Ошибка синхронизации: " + err.message);
    });

    PARTICIPANTS_COL.onSnapshot(function(snap){
      snap.docChanges().forEach(function(change){
        const p = change.doc.data();
        if(change.type === "removed"){
          state.participants = state.participants.filter(function(x){ return x.id!==p.id; });
          delete lastSyncedParticipants[p.id];
        } else {
          const idx = state.participants.findIndex(function(x){ return x.id===p.id; });
          if(idx>=0) state.participants[idx] = p; else state.participants.push(p);
          lastSyncedParticipants[p.id] = JSON.stringify(p);
        }
      });
      renderAll();
    }, function(err){
      console.error("participants snapshot error", err);
      setSyncStatus("error", "Ошибка подключения к базе — проверьте интернет и настройки доступа");
      showToast("Ошибка синхронизации: " + err.message);
    });
  }

  function uid(){
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  // ---------------------------------------------------------------
  // Time helpers
  // ---------------------------------------------------------------
  function pad(n, len){ len = len||2; n = Math.floor(n); return String(n).padStart(len,"0"); }

  function formatClock(ms){
    const d = new Date(ms);
    return pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds());
  }
  function formatClockCenti(ms){
    const d = new Date(ms);
    return pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds())+"."+pad(d.getMilliseconds()/10,2);
  }
  // duration in ms -> HH:MM:SS.cc (or MM:SS.cc if under an hour, but keep consistent HH:MM:SS.cc)
  function formatDuration(ms){
    if(ms == null || isNaN(ms)) return "—";
    const neg = ms < 0;
    ms = Math.abs(ms);
    const totalCenti = Math.floor(ms/10);
    const centi = totalCenti % 100;
    const totalSec = Math.floor(totalCenti/100);
    const sec = totalSec % 60;
    const totalMin = Math.floor(totalSec/60);
    const min = totalMin % 60;
    const hrs = Math.floor(totalMin/60);
    const str = (hrs>0? pad(hrs)+":" : "") + pad(min)+":"+pad(sec)+"."+pad(centi,2);
    return (neg? "-" : "") + str;
  }
  function formatMMSS(sec){
    const neg = sec < 0;
    sec = Math.abs(Math.round(sec));
    const m = Math.floor(sec/60), s = sec%60;
    return (neg?"-":"") + pad(m)+":"+pad(s);
  }

  // ---------------------------------------------------------------
  // Audio (Web Audio API - no external files, works fully offline)
  // ---------------------------------------------------------------
  let audioCtx = null;
  function getAudioCtx(){
    if(!audioCtx){
      try{ audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }
      catch(e){ console.warn("Web Audio unavailable", e); }
    }
    return audioCtx;
  }
  function beep(freq, durationMs, delayMs, volume){
    const ctx = getAudioCtx();
    if(!ctx) return;
    delayMs = delayMs||0; volume = volume==null?0.2:volume;
    const startAt = ctx.currentTime + delayMs/1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt+0.01);
    gain.gain.linearRampToValueAtTime(0, startAt + durationMs/1000);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durationMs/1000 + 0.02);
  }
  function soundStart(){ beep(880,150,0,0.22); }
  function soundTenSec(){ beep(660,150,0,0.18); beep(660,150,220,0.18); }
  function soundGo(){ beep(990,180,0,0.24); beep(990,180,230,0.24); beep(990,260,460,0.24); }
  function soundFinish(){ beep(520,180,0,0.2); }

  // ---------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>t.classList.remove("show"), 2400);
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  document.getElementById("tabs").addEventListener("click", (e)=>{
    const btn = e.target.closest("button[data-tab]");
    if(!btn || !tabAllowed(btn.dataset.tab)) return;
    document.querySelectorAll("nav.tabs button").forEach(b=>b.classList.toggle("active", b===btn));
    document.querySelectorAll("section.tab").forEach(s=>s.classList.toggle("active", s.id === "tab-"+btn.dataset.tab));
    renderAll();
  });

  // ---------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------
  // Theme is per-device (localStorage only, never synced via Firestore)
  const THEME_STORAGE_KEY = "racetimer_theme_v1";
  function getLocalTheme(){ return localStorage.getItem(THEME_STORAGE_KEY) || "dark"; }
  function setLocalTheme(t){ localStorage.setItem(THEME_STORAGE_KEY, t); }

  function applyTheme(){
    document.documentElement.setAttribute("data-theme", getLocalTheme());
  }
  document.getElementById("themeToggle").addEventListener("click", ()=>{
    const next = getLocalTheme() === "dark" ? "light" : "dark";
    setLocalTheme(next);
    applyTheme();
  });

  // ---------------------------------------------------------------
  // Participants CRUD
  // ---------------------------------------------------------------
  function getParticipant(id){ return state.participants.find(p=>p.id===id); }

  function bibExists(bib, excludeId){
    if(!bib) return false;
    return state.participants.some(p => p.bib === bib && p.id !== excludeId);
  }

  function addParticipant(bib, name, category, gender, ageGroup){
    bib = (bib||"").trim();
    name = (name||"").trim();
    if(!name){ showToast("Укажите имя участника"); return false; }
    if(bib && bibExists(bib)){ showToast("Номер "+bib+" уже используется"); return false; }
    state.participants.push({
      id: uid(), bib, name,
      category: category || "Бег",
      gender: gender || "М",
      ageGroup: (ageGroup||"").trim(),
      status: bib ? "waiting" : "preregistered",
      startTime: null,
      finishTime: null,
      startOrder: 0
    });
    saveState();
    return true;
  }

  function assignBib(id){
    const p = getParticipant(id);
    if(!p) return;
    const input = prompt("Номер участника для «"+p.name+"»:", p.bib || "");
    if(input === null) return;
    const bib = input.trim();
    if(!bib){ showToast("Номер не может быть пустым"); return; }
    if(bibExists(bib, id)){ showToast("Номер "+bib+" уже используется"); return; }
    p.bib = bib;
    if(p.status === "preregistered") p.status = "waiting";
    saveState();
    renderAll();
    showToast("Участнику «"+p.name+"» присвоен номер "+bib);
  }

  function editParticipant(id){
    const p = getParticipant(id);
    if(!p) return;
    const nameInput = prompt("Имя, фамилия:", p.name);
    if(nameInput === null) return;
    const newName = nameInput.trim();
    if(!newName){ showToast("Имя не может быть пустым"); return; }
    const bibInput = prompt("Номер (оставьте пустым, если ещё не выдан):", p.bib || "");
    if(bibInput === null) return;
    const newBib = bibInput.trim();
    if(newBib && bibExists(newBib, id)){ showToast("Номер "+newBib+" уже используется"); return; }
    p.name = newName;
    p.bib = newBib;
    // keep status in sync only between preregistered/waiting; never touch racing/finished
    if(p.status === "preregistered" && newBib) p.status = "waiting";
    if(p.status === "waiting" && !newBib) p.status = "preregistered";
    saveState();
    renderAll();
    showToast("Данные участника обновлены");
  }

  function markDns(id){
    const p = getParticipant(id);
    if(!p || (p.status !== "waiting" && p.status !== "preregistered")) return;
    p._prevStatus = p.status; // remember so undo restores correctly
    p.status = "dns";
    state.selectedNextIds = state.selectedNextIds.filter(x=>x!==id);
    saveState();
    renderAll();
    showToast((p.bib?"№"+p.bib+" отмечен":"«"+p.name+"» отмечен")+" как не явившийся");
  }

  function unmarkDns(id){
    const p = getParticipant(id);
    if(!p || p.status !== "dns") return;
    p.status = p._prevStatus || (p.bib ? "waiting" : "preregistered");
    delete p._prevStatus;
    saveState();
    renderAll();
    showToast((p.bib?"№"+p.bib:"«"+p.name+"»")+" возвращён в очередь ожидания");
  }

  function deleteParticipant(id){
    state.participants = state.participants.filter(p=>p.id!==id);
    state.selectedNextIds = state.selectedNextIds.filter(x=>x!==id);
    saveState();
  }

  // ---------------------------------------------------------------
  // CSV parsing / import
  // ---------------------------------------------------------------
  function parseCsvLine(line){
    // simple quote-aware CSV splitter
    const out = []; let cur = ""; let inQuotes = false;
    for(let i=0;i<line.length;i++){
      const c = line[i];
      if(inQuotes){
        if(c === '"'){
          if(line[i+1] === '"'){ cur+='"'; i++; } else { inQuotes=false; }
        } else cur += c;
      } else {
        if(c === '"') inQuotes = true;
        else if(c === ","){ out.push(cur); cur=""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out.map(s=>s.trim());
  }

  const HEADER_ALIASES = {
    bib: ["bib","номер","№","number"],
    name: ["name","имя","фио","имя фамилия","name lastname"],
    category: ["category","категория"],
    gender: ["gender","пол","sex"],
    ageGroup: ["agegroup","age group","группа","возрастная группа","age"]
  };
  function matchHeader(headerCell){
    const h = headerCell.trim().toLowerCase();
    for(const key in HEADER_ALIASES){
      if(HEADER_ALIASES[key].includes(h)) return key;
    }
    return null;
  }

  function importCsvText(text){
    const lines = text.split(/\r\n|\n|\r/).filter(l=>l.trim().length>0);
    if(lines.length < 2) return {added:0, skipped:0, errors:["Файл пуст или содержит только заголовок"]};
    const headerCells = parseCsvLine(lines[0]);
    const colMap = {}; // index -> key
    headerCells.forEach((cell, idx)=>{
      const key = matchHeader(cell);
      if(key) colMap[idx] = key;
    });
    if(Object.values(colMap).indexOf("name") === -1){
      return {added:0, skipped:0, errors:["Не найден столбец с именем участника (name/имя)"]};
    }
    let added=0, skipped=0; const errors=[];
    for(let i=1;i<lines.length;i++){
      const cells = parseCsvLine(lines[i]);
      const rec = {bib:"",name:"",category:"Бег",gender:"М",ageGroup:""};
      Object.keys(colMap).forEach(idxStr=>{
        const idx = Number(idxStr);
        const key = colMap[idx];
        if(cells[idx] !== undefined) rec[key] = cells[idx];
      });
      if(!rec.name){ skipped++; continue; }
      // normalize category
      const catNorm = (rec.category||"").toLowerCase();
      rec.category = catNorm.startsWith("вел") || catNorm.startsWith("bike") ? "Велосипед" : "Бег";
      const genNorm = (rec.gender||"").toUpperCase();
      rec.gender = genNorm.startsWith("Ж") || genNorm.startsWith("F") ? "Ж" : "М";
      const ok = addParticipant(rec.bib, rec.name, rec.category, rec.gender, rec.ageGroup);
      if(ok) added++; else skipped++;
    }
    return {added, skipped, errors};
  }

  document.getElementById("btnImportCsv").addEventListener("click", ()=>{
    if(!can("importCsv")) return;
    const fileInput = document.getElementById("csvFile");
    const file = fileInput.files && fileInput.files[0];
    const statusEl = document.getElementById("importStatus");
    if(!file){ statusEl.textContent = "Выберите CSV файл"; return; }
    const reader = new FileReader();
    reader.onload = function(e){
      const result = importCsvText(String(e.target.result));
      if(result.errors.length){
        statusEl.textContent = "Ошибка: " + result.errors.join("; ");
      } else {
        statusEl.textContent = "Импортировано: " + result.added + ", пропущено: " + result.skipped;
      }
      renderAll();
    };
    reader.onerror = function(){ statusEl.textContent = "Не удалось прочитать файл"; };
    reader.readAsText(file, "utf-8");
  });

  document.getElementById("btnExportParticipants").addEventListener("click", ()=>{
    if(!can("importCsv")) return;
    if(!state.participants.length){ showToast("Список участников пуст — нечего экспортировать"); return; }
    const header = ["bib","name","category","gender","agegroup","status"];
    const lines = [header.join(",")];
    state.participants.forEach(p=>{
      lines.push([p.bib, csvEscape(p.name), p.category, p.gender, csvEscape(p.ageGroup||""), p.status].join(","));
    });
    downloadBlob("\uFEFF"+lines.join("\r\n"), "racetimer_participants.csv", "text/csv;charset=utf-8");
    showToast("Список участников экспортирован ("+state.participants.length+")");
  });

  // ---------------------------------------------------------------
  // Add participant form
  // ---------------------------------------------------------------
  document.getElementById("btnAddParticipant").addEventListener("click", ()=>{
    if(!can("addParticipant")) return;
    const bib = document.getElementById("addBib").value;
    const name = document.getElementById("addName").value;
    const category = document.getElementById("addCategory").value;
    const gender = document.getElementById("addGender").value;
    const ageGroup = document.getElementById("addAgeGroup").value;
    const trimmedName = (name||"").trim();
    const trimmedBib = (bib||"").trim();
    const ok = addParticipant(bib, name, category, gender, ageGroup);
    if(ok){
      document.getElementById("addBib").value = "";
      document.getElementById("addName").value = "";
      document.getElementById("addAgeGroup").value = "";
      document.getElementById("addName").focus();
      showToast(trimmedBib ? "Участник №"+trimmedBib+" добавлен" : "Участник «"+trimmedName+"» добавлен без номера");
      renderAll();
    }
  });
  document.getElementById("addName").addEventListener("keydown", (e)=>{
    if(e.key === "Enter") document.getElementById("addBib").focus();
  });
  document.getElementById("addBib").addEventListener("keydown", (e)=>{
    if(e.key === "Enter") document.getElementById("btnAddParticipant").click();
  });

  // ---------------------------------------------------------------
  // Participants table render
  // ---------------------------------------------------------------
  function statusLabel(s){
    if(s==="preregistered") return "Без номера";
    if(s==="waiting") return "Ожидает";
    if(s==="racing") return "На дистанции";
    if(s==="dnf") return "Сошёл с дистанции";
    if(s==="dns") return "Не явился";
    return "Финишировал";
  }
  function statusBadgeClass(s){ return s; }

  function renderParticipantsTable(){
    const search = document.getElementById("participantSearch").value.trim().toLowerCase();
    const catFilter = document.getElementById("categoryFilter").value;
    const body = document.getElementById("participantsBody");
    body.innerHTML = "";

    document.getElementById("csvCard").style.display = can("importCsv") ? "" : "none";

    let list = state.participants.slice().sort((a,b)=>{
      const aHas = !!a.bib, bHas = !!b.bib;
      if(aHas && bHas) return (a.bib.length-b.bib.length) || a.bib.localeCompare(b.bib,'ru',{numeric:true});
      if(!aHas && !bHas) return a.name.localeCompare(b.name,'ru');
      return aHas ? 1 : -1; // participants awaiting a number are listed first
    });
    if(catFilter) list = list.filter(p=>p.category===catFilter);
    if(search) list = list.filter(p => p.bib.toLowerCase().includes(search) || p.name.toLowerCase().includes(search));

    document.getElementById("participantsEmpty").style.display = list.length? "none":"block";

    list.forEach(p=>{
      const tr = document.createElement("tr");
      const bibCell = p.bib
        ? '<span class="bib mono">'+escapeHtml(p.bib)+'</span>'
        : '<span style="color:var(--text-faint);">—</span>';
      const assignBtn = (p.status === "preregistered" && can("assignBib"))
        ? '<button class="btn small primary" data-assign="'+p.id+'">Выдать номер</button> '
        : '';
      let dnsBtn = "";
      if(can("dns")){
        if(p.status === "waiting" || p.status === "preregistered")
          dnsBtn = '<button class="btn small" data-dns="'+p.id+'">Не явился</button> ';
        else if(p.status === "dns")
          dnsBtn = '<button class="btn small primary" data-undo-dns="'+p.id+'">Вернуть в очередь</button> ';
      }
      const orderEditable = (p.status === "waiting" || p.status === "dns") && can("setStartOrder");
      const orderCell = orderEditable
        ? '<input type="number" class="startorder-input mono" min="0" step="1" value="'+(p.startOrder||0)+'" data-order-id="'+p.id+'">'
        : (p.startOrder ? String(p.startOrder) : '<span style="color:var(--text-faint);">—</span>');
      const editBtn = can("editParticipant") ? '<button class="btn small" data-edit-p="'+p.id+'">Редакт.</button> ' : '';
      const timeBtn = (can("editParticipant") && (p.status==="racing"||p.status==="finished"||p.status==="dnf"))
        ? '<button class="btn small" data-edit-time="'+p.id+'">Время</button> ' : '';
      const delBtn = can("deleteParticipant") ? '<button class="btn small danger" data-del="'+p.id+'">Удалить</button>' : '';
      tr.innerHTML =
        '<td data-label="№">'+bibCell+'</td>'+
        '<td data-label="Имя">'+escapeHtml(p.name)+'</td>'+
        '<td data-label="Категория"><span class="badge '+(p.category==="Велосипед"?"bike":"run")+'">'+escapeHtml(p.category)+'</span></td>'+
        '<td data-label="Пол">'+escapeHtml(p.gender)+'</td>'+
        '<td data-label="Группа">'+escapeHtml(p.ageGroup||"—")+'</td>'+
        '<td data-label="Оч. старта">'+orderCell+'</td>'+
        '<td data-label="Статус"><span class="badge '+statusBadgeClass(p.status)+'">'+statusLabel(p.status)+'</span></td>'+
        '<td data-actions>'+assignBtn+dnsBtn+editBtn+timeBtn+delBtn+'</td>';
      body.appendChild(tr);
    });

    body.querySelectorAll("[data-order-id]").forEach(inp=>{
      inp.addEventListener("change", ()=>{
        const p = getParticipant(inp.dataset.orderId);
        if(!p || !can("setStartOrder")) return;
        let v = parseInt(inp.value,10);
        if(isNaN(v) || v<0) v = 0;
        p.startOrder = v;
        inp.value = v;
        saveState();
      });
    });

    body.querySelectorAll("[data-assign]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ if(can("assignBib")) assignBib(btn.dataset.assign); });
    });

    body.querySelectorAll("[data-dns]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ if(can("dns")) markDns(btn.dataset.dns); });
    });
    body.querySelectorAll("[data-undo-dns]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ if(can("dns")) unmarkDns(btn.dataset.undoDns); });
    });

    body.querySelectorAll("[data-edit-p]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ if(can("editParticipant")) editParticipant(btn.dataset.editP); });
    });

    body.querySelectorAll("[data-edit-time]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ if(can("editParticipant")) openEditModal(btn.dataset.editTime); });
    });

    body.querySelectorAll("[data-del]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        if(!can("deleteParticipant")) return;
        const p = getParticipant(btn.dataset.del);
        if(!p) return;
        const label = p.bib ? "№"+p.bib+" ("+p.name+")" : p.name+" (без номера)";
        if(confirm("Удалить участника "+label+"?")){
          deleteParticipant(btn.dataset.del);
          renderAll();
        }
      });
    });
  }
  document.getElementById("participantSearch").addEventListener("input", renderParticipantsTable);
  document.getElementById("categoryFilter").addEventListener("change", renderParticipantsTable);

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  // ---------------------------------------------------------------
  // Start tab: settings
  // ---------------------------------------------------------------
  document.getElementById("intervalInput").addEventListener("change", (e)=>{
    if(!can("start")){ e.target.value = state.settings.intervalSec; return; }
    let v = parseInt(e.target.value,10);
    if(isNaN(v) || v < 5) v = 5;
    state.settings.intervalSec = v;
    e.target.value = v;
    saveState();
  });

  document.getElementById("startModeToggle").addEventListener("click", (e)=>{
    if(!can("start")) return;
    const btn = e.target.closest("button[data-startmode]");
    if(!btn) return;
    state.settings.startMode = btn.dataset.startmode;
    document.querySelectorAll("#startModeToggle button").forEach(b=>b.classList.toggle("active", b===btn));
    resetCountdown();
    saveState();
    renderStartTab();
  });

  // ---------------------------------------------------------------
  // Queue selection & start logic
  // ---------------------------------------------------------------
  function waitingList(){
    return state.participants
      .filter(p=>p.status==="waiting")
      .sort((a,b)=>{
        const ao = a.startOrder||0, bo = b.startOrder||0;
        // participants with a manually assigned start order (>0) come first, ascending;
        // participants left at 0 keep the default order (by bib) and come after
        if(ao>0 && bo>0 && ao!==bo) return ao-bo;
        if(ao>0 && bo===0) return -1;
        if(ao===0 && bo>0) return 1;
        return (a.bib.length-b.bib.length) || a.bib.localeCompare(b.bib,'ru',{numeric:true});
      });
  }

  function computeDefaultNextGroup(){
    const w = waitingList();
    if(!w.length) return [];
    const first = w[0];
    if(first.startOrder && first.startOrder>0){
      // everyone sharing the same manually-assigned start order starts together
      return w.filter(p=>p.startOrder===first.startOrder).map(p=>p.id);
    }
    return [first.id];
  }

  function autoFillSelection(){
    // remove ids no longer waiting
    state.selectedNextIds = state.selectedNextIds.filter(id=>{
      const p = getParticipant(id); return p && p.status==="waiting";
    });
    if(state.selectedAuto){
      // still system-managed (operator hasn't manually touched checkboxes yet) —
      // always recompute fresh, so start-order edits made after the fact still apply
      state.selectedNextIds = computeDefaultNextGroup();
    }
    // if the operator has taken manual control (selectedAuto === false), leave the
    // selection exactly as they left it — including empty, if they unchecked everyone
  }

  function toggleSelect(id){
    if(!can("start")) return;
    // operator is taking manual control of the selection from here on
    state.selectedAuto = false;
    // free-form selection: any number of participants (1, 2, 3, or more)
    const idx = state.selectedNextIds.indexOf(id);
    if(idx >= 0){
      state.selectedNextIds.splice(idx,1);
    } else {
      state.selectedNextIds.push(id);
    }
    saveState();
    renderStartTab();
  }

  function resetCountdown(){
    if(state.settings.startMode === "manual" || waitingList().length === 0){
      // manual mode, or nobody left in the queue: no countdown runs
      state.countdown.nextStartAt = null;
    } else {
      state.countdown.nextStartAt = Date.now() + state.settings.intervalSec*1000;
    }
    state.countdown.tenSecFired = false;
    state.countdown.zeroFired = false;
  }

  function doStart(){
    if(!can("start")) return;
    if(state.selectedNextIds.length === 0){ showToast("Выберите участника(ов) для старта"); return; }
    const now = Date.now();
    state.selectedNextIds.forEach(id=>{
      const p = getParticipant(id);
      if(p && p.status==="waiting"){ p.startTime = now; p.status = "racing"; }
    });
    state.selectedNextIds = [];
    state.selectedAuto = true; // fresh round: auto-suggest the next default group again
    autoFillSelection();
    resetCountdown();
    soundStart();
    saveState();
    renderAll();
  }
  document.getElementById("btnBigStart").addEventListener("click", doStart);

  function finishParticipant(id){
    if(!can("finish")) return false;
    const p = getParticipant(id);
    if(!p || p.status !== "racing"){ return false; }
    p.finishTime = Date.now();
    p.status = "finished";
    saveState();
    soundFinish();
    return true;
  }

  function revertStart(id){
    if(!can("revertStart")) return;
    const p = getParticipant(id);
    if(!p || p.status !== "racing") return;
    p.startTime = null;
    p.status = "waiting";
    saveState();
    renderAll();
    showToast("№"+p.bib+" возвращён в очередь на старт");
  }

  function markDnf(id){
    if(!can("dnf")) return;
    const p = getParticipant(id);
    if(!p || p.status !== "racing") return;
    p.status = "dnf";
    saveState();
    renderAll();
    showToast("№"+p.bib+" отмечен как сошедший с дистанции");
  }

  document.getElementById("btnQuickFinish").addEventListener("click", ()=>{
    if(!can("finish")) return;
    const bib = document.getElementById("quickBibInput").value.trim();
    const msg = document.getElementById("quickFinishMsg");
    if(!bib){ msg.textContent = "Введите номер участника"; return; }
    const p = state.participants.find(x=>x.bib===bib);
    if(!p){ msg.textContent = "Участник с номером "+bib+" не найден"; return; }
    if(p.status !== "racing"){ msg.textContent = "Участник №"+bib+" не находится на дистанции (статус: "+statusLabel(p.status)+")"; return; }
    finishParticipant(p.id);
    msg.textContent = "Финиш зафиксирован: №"+bib+" — "+formatDuration(p.finishTime-p.startTime);
    document.getElementById("quickBibInput").value = "";
    document.getElementById("quickBibInput").focus();
    renderAll();
  });
  document.getElementById("quickBibInput").addEventListener("keydown",(e)=>{
    if(e.key === "Enter") document.getElementById("btnQuickFinish").click();
  });

  // ---------------------------------------------------------------
  // Render: Start tab
  // ---------------------------------------------------------------
  function renderStartTab(){
    document.getElementById("startSettingsCard").style.display = can("start") ? "" : "none";
    document.getElementById("intervalInput").value = state.settings.intervalSec;
    document.querySelectorAll("#startModeToggle button").forEach(b=>b.classList.toggle("active", b.dataset.startmode===state.settings.startMode));
    const waitingCountForLabel = waitingList().length;
    let cdLabel;
    if(state.settings.startMode === "manual"){
      cdLabel = "Ручной режим — жду нажатия «Старт»";
    } else if(waitingCountForLabel === 0){
      cdLabel = "Очередь пуста — отсчёт остановлен";
    } else {
      cdLabel = "До следующего старта";
    }
    document.getElementById("countdownLabel").textContent = cdLabel;

    // queue list
    const qList = document.getElementById("queueList");
    qList.innerHTML = "";
    const waiting = waitingList();
    document.getElementById("queueEmpty").style.display = waiting.length ? "none":"block";
    waiting.forEach(p=>{
      const div = document.createElement("div");
      const selected = state.selectedNextIds.includes(p.id);
      div.className = "queue-item" + (selected ? " selected":"");
      const orderBadge = (p.startOrder && p.startOrder>0)
        ? '<span class="badge" style="background:rgba(255,90,31,.15); color:var(--accent);">оч. '+p.startOrder+'</span>'
        : '';
      div.innerHTML =
        '<span class="checkbox">'+(selected?"✓":"")+'</span>'+
        '<span class="bib mono">'+escapeHtml(p.bib)+'</span>'+
        '<span class="name">'+escapeHtml(p.name)+'</span>'+
        orderBadge+
        '<span class="badge '+(p.category==="Велосипед"?"bike":"run")+'">'+escapeHtml(p.category)+'</span>';
      div.addEventListener("click", ()=>toggleSelect(p.id));
      qList.appendChild(div);
    });

    // next up chips
    const chips = document.getElementById("nextUpChips");
    chips.innerHTML = "";
    state.selectedNextIds.forEach(id=>{
      const p = getParticipant(id);
      if(!p) return;
      const chip = document.createElement("div");
      chip.className = "next-chip";
      chip.innerHTML = '<span class="bib mono">'+escapeHtml(p.bib)+'</span><span>'+escapeHtml(p.name)+'</span>';
      chips.appendChild(chip);
    });

    document.getElementById("btnBigStart").disabled = state.selectedNextIds.length === 0 || !can("start");
  }

  // ---------------------------------------------------------------
  // On-course / finish tab
  // ---------------------------------------------------------------
  function renderOnCourseTab(){
    const oc = state.participants.filter(p=>p.status==="racing").sort((a,b)=>a.startTime-b.startTime);
    document.getElementById("onCourseCount").textContent = oc.length;
    const ocList = document.getElementById("onCourseList");
    ocList.innerHTML = "";
    document.getElementById("onCourseEmpty").style.display = oc.length ? "none":"block";
    oc.forEach(p=>{
      const row = document.createElement("div");
      row.className = "oncourse-row";
      const finishBtn = can("finish") ? '<button class="btn small primary" data-finish="'+p.id+'">Финиш</button>' : '';
      const revertBtn = can("revertStart") ? '<button class="btn small" data-revert="'+p.id+'" title="Если запустили по ошибке">Вернуть на старт</button>' : '';
      const dnfBtn = can("dnf") ? '<button class="btn small danger" data-dnf="'+p.id+'" title="Сошёл с дистанции">Сошёл</button>' : '';
      row.innerHTML =
        '<span class="bib mono">'+escapeHtml(p.bib)+'</span>'+
        '<span class="name">'+escapeHtml(p.name)+'</span>'+
        '<span class="elapsed mono" data-elapsed-for="'+p.id+'">--:--</span>'+
        '<div class="oncourse-actions">'+finishBtn+revertBtn+dnfBtn+'</div>';
      ocList.appendChild(row);
    });
    ocList.querySelectorAll("[data-finish]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        if(!can("finish")) return;
        const p = getParticipant(btn.dataset.finish);
        finishParticipant(btn.dataset.finish);
        showToast("Финиш: №"+p.bib+" — "+formatDuration(p.finishTime-p.startTime));
        renderAll();
      });
    });
    ocList.querySelectorAll("[data-revert]").forEach(btn=>{
      btn.addEventListener("click", ()=>revertStart(btn.dataset.revert));
    });
    ocList.querySelectorAll("[data-dnf]").forEach(btn=>{
      btn.addEventListener("click", ()=>markDnf(btn.dataset.dnf));
    });
    document.getElementById("btnQuickFinish").disabled = !can("finish");

    // DNF (сошли с дистанции) — undo lives here, close to where it happened
    const dnfList = state.participants.filter(p=>p.status==="dnf");
    document.getElementById("oncourseDnfCard").style.display = dnfList.length ? "block" : "none";
    const dnfBody = document.getElementById("oncourseDnfBody");
    dnfBody.innerHTML = "";
    dnfList.forEach(p=>{
      const tr = document.createElement("tr");
      const undoBtn = can("dnf") ? '<button class="btn small" data-undo-dnf="'+p.id+'">Вернуть на старт</button>' : '';
      tr.innerHTML =
        '<td data-label="№"><span class="bib mono">'+escapeHtml(p.bib)+'</span></td>'+
        '<td data-label="Имя">'+escapeHtml(p.name)+'</td>'+
        '<td data-label="Категория"><span class="badge '+(p.category==="Велосипед"?"bike":"run")+'">'+escapeHtml(p.category)+'</span></td>'+
        '<td data-actions>'+undoBtn+'</td>';
      dnfBody.appendChild(tr);
    });
    dnfBody.querySelectorAll("[data-undo-dnf]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        if(!can("dnf")) return;
        const p = getParticipant(btn.dataset.undoDnf);
        if(!p) return;
        p.startTime = null;
        p.status = "waiting"; // back to the start queue, not straight onto the course
        saveState();
        renderAll();
        showToast("№"+p.bib+" возвращён в очередь на старт");
      });
    });
  }

  // ---------------------------------------------------------------
  // Results tab
  // ---------------------------------------------------------------
  function computeResults(overall){
    const finished = state.participants.filter(p=>p.status==="finished");
    finished.forEach(p=>{ p._net = p.finishTime - p.startTime; });
    if(overall){
      // rank everyone together, ignoring category
      finished.sort((a,b)=>a._net-b._net);
      finished.forEach((p,i)=>{ p._place = i+1; });
    } else {
      // sort and rank within each category separately
      const byCat = {};
      finished.forEach(p=>{
        byCat[p.category] = byCat[p.category] || [];
        byCat[p.category].push(p);
      });
      Object.keys(byCat).forEach(cat=>{
        byCat[cat].sort((a,b)=>a._net-b._net);
        byCat[cat].forEach((p,i)=>{ p._place = i+1; });
      });
    }
    return finished.sort((a,b)=>a._net-b._net);
  }

  function renderProtocolTab(){
    // ---- Единый список: ожидание + на дистанции + финиш + сошли/не явились,
    //      отсортирован по фамилии, статус виден только по заливке фона ----
    const allSorted = state.participants
      .filter(p=>p.status==="waiting" || p.status==="racing" || p.status==="finished" || p.status==="dns" || p.status==="dnf")
      .slice()
      .sort((a,b)=>a.name.localeCompare(b.name,'ru'));
    document.getElementById("protoAllCount").textContent = allSorted.length;
    const allEl = document.getElementById("protoAllList");
    allEl.innerHTML = "";
    document.getElementById("protoAllEmpty").style.display = allSorted.length ? "none":"block";
    allSorted.forEach(p=>{
      const row = document.createElement("div");
      const statusClass = (p.status==="waiting") ? "status-waiting"
        : (p.status==="racing") ? "status-racing"
        : (p.status==="finished") ? "status-finished"
        : "status-out"; // dns or dnf
      row.className = "protocol-row " + statusClass;
      let extra = protoStatusIcon(p.status, p.category);
      if(p.status==="racing") extra += '<span class="elapsed" data-elapsed-for="'+p.id+'">--:--</span>';
      row.innerHTML = protocolRowHtml(p) + extra;
      allEl.appendChild(row);
    });

    // ---- Готовятся (checked by the start judge, next to launch) ----
    // Empty whenever the judge has unchecked everyone — never auto-refilled here.
    const prepList = state.selectedNextIds.map(id=>getParticipant(id)).filter(Boolean);
    const pEl = document.getElementById("protoPrepList");
    pEl.innerHTML = "";
    document.getElementById("protoPrepEmpty").style.display = prepList.length ? "none":"block";
    prepList.forEach(p=>{
      const row = document.createElement("div");
      row.className = "protocol-row prep";
      row.innerHTML = protocolRowHtml(p);
      pEl.appendChild(row);
    });

    // ---- Онлайн результат (finished, sorted by net time; no start/finish columns) ----
    const catFilter = document.getElementById("resultsCategoryFilter").value;
    let results = computeResults(!catFilter);
    if(catFilter) results = results.filter(p=>p.category===catFilter);
    const body = document.getElementById("resultsBody");
    body.innerHTML = "";
    document.getElementById("resultsEmpty").style.display = results.length ? "none":"block";
    results.forEach(p=>{
      const placeClass = p._place===1?"p1":p._place===2?"p2":p._place===3?"p3":"";
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td data-label="Место"><span class="place '+placeClass+'">'+p._place+'</span></td>'+
        '<td data-label="№"><span class="bib mono">'+escapeHtml(p.bib)+'</span></td>'+
        '<td data-label="Имя">'+escapeHtml(p.name)+'</td>'+
        '<td data-label="Категория"><span class="badge '+(p.category==="Велосипед"?"bike":"run")+'">'+escapeHtml(p.category)+'</span></td>'+
        '<td data-label="Чистое время" class="mono" style="font-weight:800;">'+formatDuration(p._net)+'</td>';
      body.appendChild(tr);
    });

    // admin-only reset control, shown right here for convenience
    document.getElementById("adminResetCard").style.display = isAdmin() ? "block" : "none";
  }
  // ---------------------------------------------------------------
  // Protocol icons — PNG files from pics/ folder.
  // To replace an icon: swap the .png file on GitHub. No JS needed.
  // Files: wait.png, run.png, cycle.png, finish.png, dns.png, dnf.png
  // Recommended size: 48×48 px, transparent or solid background.
  // ---------------------------------------------------------------
  function protoStatusIcon(status, category){
    let key;
    if(status === "racing")        key = category === "Велосипед" ? "cycle" : "run";
    else if(status === "finished") key = "finish";
    else if(status === "dns")      key = "dns";
    else if(status === "dnf")      key = "dnf";
    else                           key = "wait";
    return '<img class="proto-icon" src="pics/'+key+'.png" alt="'+key+'">';
  }

  function protocolRowHtml(p){
    const catAbbr = p.category === "Велосипед" ? "(В)" : "(Б)";
    return '<span class="bib mono">'+escapeHtml(p.bib)+'</span>'+
      '<span class="name">'+escapeHtml(p.name)+' <span class="proto-cat">'+catAbbr+'</span></span>';
  }
  document.getElementById("resultsCategoryFilter").addEventListener("change", renderProtocolTab);

  // simple prompt-based time correction (kept dependency-free)
  function openEditModal(id){
    const p = getParticipant(id);
    if(!p) return;
    const startStr = prompt("Время старта (ЧЧ:ММ:СС) для №"+p.bib+":", formatClock(p.startTime));
    if(startStr === null) return;
    const finishStr = prompt("Время финиша (ЧЧ:ММ:СС) для №"+p.bib+":", formatClock(p.finishTime));
    if(finishStr === null) return;
    const newStart = parseClockToday(startStr, p.startTime);
    const newFinish = parseClockToday(finishStr, p.finishTime);
    if(newStart===null || newFinish===null){ showToast("Неверный формат времени"); return; }
    p.startTime = newStart; p.finishTime = newFinish;
    saveState();
    renderAll();
    showToast("Время для №"+p.bib+" обновлено");
  }
  function parseClockToday(str, refMs){
    const m = str.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if(!m) return null;
    const d = new Date(refMs);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), d.getMilliseconds());
    return d.getTime();
  }

  // ---------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------
  function downloadBlob(content, filename, mime){
    const blob = new Blob([content], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }

  function resultsAsRows(){
    const results = computeResults();
    return results.map(p=>({
      place: p._place, bib: p.bib, name: p.name, category: p.category,
      start: formatClock(p.startTime), finish: formatClock(p.finishTime), net: formatDuration(p._net)
    }));
  }

  document.getElementById("btnExportCsv").addEventListener("click", ()=>{
    const rows = resultsAsRows();
    if(!rows.length){ showToast("Нет результатов для экспорта"); return; }
    const header = ["Место","Номер","Имя","Категория","Старт","Финиш","Чистое время"];
    const lines = [header.join(",")];
    rows.forEach(r=>{
      lines.push([r.place, r.bib, csvEscape(r.name), r.category, r.start, r.finish, r.net].join(","));
    });
    downloadBlob("\uFEFF"+lines.join("\r\n"), "racetimer_results.csv", "text/csv;charset=utf-8");
  });
  function csvEscape(s){
    s = String(s);
    if(/[",\n]/.test(s)) return '"'+s.replace(/"/g,'""')+'"';
    return s;
  }

  document.getElementById("btnExportXls").addEventListener("click", ()=>{
    const overallResults = computeResults(true); // ranked overall, ignoring category
    if(!overallResults.length){ showToast("Нет результатов для экспорта"); return; }

    // ---- Sheet 1: "Общая" — everyone together, no category split ----
    const header1 = ["Место","Номер","Имя","Категория","Пол","Старт","Финиш","Чистое время"];
    const sheet1Rows = [{header:true, cells: header1}];
    overallResults.forEach(p=>{
      sheet1Rows.push({cells: [p._place, p.bib, p.name, p.category, p.gender, formatClock(p.startTime), formatClock(p.finishTime), formatDuration(p._net)]});
    });

    // ---- Sheet 2: "По категориям" — split by discipline + gender, own place per group ----
    const cats = ["Бег","Велосипед"];
    const genders = ["М","Ж"];
    const groupHeader = ["Место","Номер","Имя","Старт","Финиш","Чистое время"];
    const sheet2Rows = [];
    cats.forEach(cat=>{
      genders.forEach(gen=>{
        const group = overallResults.filter(p=>p.category===cat && p.gender===gen).slice().sort((a,b)=>a._net-b._net);
        if(!group.length) return;
        sheet2Rows.push({title:true, cells: [cat+" — "+gen]});
        sheet2Rows.push({header:true, cells: groupHeader});
        group.forEach((p,i)=>{
          sheet2Rows.push({cells: [i+1, p.bib, p.name, formatClock(p.startTime), formatClock(p.finishTime), formatDuration(p._net)]});
        });
        sheet2Rows.push({cells: []}); // blank spacer row
      });
    });
    if(!sheet2Rows.length) sheet2Rows.push({cells: ["Нет данных"]});

    const blob = buildXlsxBlob([
      {name:"Общая", rows: sheet1Rows},
      {name:"По категориям", rows: sheet2Rows}
    ]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "racetimer_results.xlsx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
    showToast("Экспортировано в Excel: 2 вкладки — «Общая» и «По категориям»");
  });

  // ---------------------------------------------------------------
  // Minimal dependency-free .xlsx (OOXML) writer — no external
  // libraries, works fully offline. Builds a real multi-sheet
  // workbook using an uncompressed (STORED) ZIP container, with
  // auto-sized columns, thin borders on every data cell, and a
  // styled (bold, filled) header row.
  // ---------------------------------------------------------------
  function xmlEscape(s){
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function colLetter(n){
    let s = "";
    while(n > 0){
      const rem = (n-1) % 26;
      s = String.fromCharCode(65+rem) + s;
      n = Math.floor((n-1)/26);
    }
    return s;
  }
  // style indices, must match the cellXfs order defined in buildStylesXml()
  const XLSX_STYLE = { normal:0, header:1, bordered:2, title:3 };

  function buildSheetXml(rowsSpec){
    let rowsXml = "";
    const colMaxLen = [];
    rowsSpec.forEach((rowSpec, ri)=>{
      const rNum = ri+1;
      const cells = rowSpec.cells || [];
      const styleIdx = rowSpec.header ? XLSX_STYLE.header : (rowSpec.title ? XLSX_STYLE.title : XLSX_STYLE.bordered);
      let cellsXml = "";
      // still draw bordered cells across the full row width even where a sheet
      // has short rows (e.g. title rows), so the grid looks even
      const rowWidth = Math.max(cells.length, rowSpec.title ? 1 : 0);
      for(let ci=0; ci<rowWidth; ci++){
        const val = cells[ci];
        const strLen = (val===null||val===undefined) ? 0 : String(val).length;
        colMaxLen[ci] = Math.max(colMaxLen[ci]||0, strLen);
        const ref = colLetter(ci+1)+rNum;
        if(val === null || val === undefined || val === ""){
          if(!rowSpec.title) cellsXml += '<c r="'+ref+'" s="'+styleIdx+'"/>';
          continue;
        }
        if(typeof val === "number" && isFinite(val)){
          cellsXml += '<c r="'+ref+'" s="'+styleIdx+'"><v>'+val+'</v></c>';
        } else {
          cellsXml += '<c r="'+ref+'" s="'+styleIdx+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEscape(val)+'</t></is></c>';
        }
      }
      rowsXml += '<row r="'+rNum+'">'+cellsXml+'</row>';
    });

    const colsXml = colMaxLen.length
      ? '<cols>' + colMaxLen.map((len,i)=>{
          const width = Math.min(42, Math.max(8, len + 3));
          return '<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+width+'" customWidth="1"/>';
        }).join('') + '</cols>'
      : '';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>'+
      colsXml +
      '<sheetData>'+rowsXml+'</sheetData>'+
      '</worksheet>';
  }

  function buildStylesXml(){
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
        '<fonts count="3">'+
          '<font><sz val="11"/><name val="Calibri"/></font>'+
          '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'+
          '<font><b/><sz val="11"/><name val="Calibri"/></font>'+
        '</fonts>'+
        '<fills count="3">'+
          '<fill><patternFill patternType="none"/></fill>'+
          '<fill><patternFill patternType="gray125"/></fill>'+
          '<fill><patternFill patternType="solid"><fgColor rgb="FFFF5A1F"/><bgColor indexed="64"/></patternFill></fill>'+
        '</fills>'+
        '<borders count="2">'+
          '<border><left/><right/><top/><bottom/><diagonal/></border>'+
          '<border>'+
            '<left style="thin"><color rgb="FFC9C9C9"/></left>'+
            '<right style="thin"><color rgb="FFC9C9C9"/></right>'+
            '<top style="thin"><color rgb="FFC9C9C9"/></top>'+
            '<bottom style="thin"><color rgb="FFC9C9C9"/></bottom>'+
            '<diagonal/>'+
          '</border>'+
        '</borders>'+
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
        '<cellXfs count="4">'+
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
          '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'+
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'+
          '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'+
        '</cellXfs>'+
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'+
      '</styleSheet>';
  }

  function buildXlsxBlob(sheets){
    const encoder = new TextEncoder();
    const files = [];
    const stylesRid = sheets.length + 1;

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
      '<Default Extension="xml" ContentType="application/xml"/>'+
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+
      sheets.map((s,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")+
      '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'+
      '</Relationships>';

    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
      '<sheets>'+ sheets.map((s,i)=>'<sheet name="'+xmlEscape(s.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join("") +'</sheets></workbook>';

    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      sheets.map((s,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join("")+
      '<Relationship Id="rId'+stylesRid+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'+
      '</Relationships>';

    files.push({name:"[Content_Types].xml", data: encoder.encode(contentTypes)});
    files.push({name:"_rels/.rels", data: encoder.encode(rootRels)});
    files.push({name:"xl/workbook.xml", data: encoder.encode(workbookXml)});
    files.push({name:"xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels)});
    files.push({name:"xl/styles.xml", data: encoder.encode(buildStylesXml())});
    sheets.forEach((s,i)=>{
      files.push({name:"xl/worksheets/sheet"+(i+1)+".xml", data: encoder.encode(buildSheetXml(s.rows))});
    });

    const zipBytes = buildZipStored(files);
    return new Blob([zipBytes], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  }

  // CRC32 (standard table-based implementation)
  let crc32Table = null;
  function crc32(bytes){
    if(!crc32Table){
      crc32Table = [];
      for(let n=0;n<256;n++){
        let c = n;
        for(let k=0;k<8;k++){ c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); }
        crc32Table[n] = c;
      }
    }
    let crc = 0 ^ (-1);
    for(let i=0;i<bytes.length;i++){
      crc = (crc>>>8) ^ crc32Table[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  // Minimal ZIP writer using STORED (uncompressed) entries — valid ZIP
  // per spec, no compression library required, fully offline.
  function buildZipStored(files){
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const dosTime = 0, dosDate = 0x21; // fixed placeholder timestamp

    files.forEach(f=>{
      const nameBytes = encoder.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const size = data.length;

      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true); // method 0 = stored
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(central.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, dosTime, true);
      cdv.setUint16(14, dosDate, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, size, true);
      cdv.setUint32(24, size, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    });

    const centralStart = offset;
    let centralSize = 0;
    centralParts.forEach(c=>{ centralSize += c.length; });

    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(4, 0, true);
    edv.setUint16(6, 0, true);
    edv.setUint16(8, files.length, true);
    edv.setUint16(10, files.length, true);
    edv.setUint32(12, centralSize, true);
    edv.setUint32(16, centralStart, true);
    edv.setUint16(20, 0, true);

    const allParts = localParts.concat(centralParts, [eocd]);
    let totalLen = 0;
    allParts.forEach(p=>{ totalLen += p.length; });
    const out = new Uint8Array(totalLen);
    let pos = 0;
    allParts.forEach(p=>{ out.set(p, pos); pos += p.length; });
    return out;
  }

  // ---------------------------------------------------------------
  // Reset all
  // ---------------------------------------------------------------
  document.getElementById("btnResetAll").addEventListener("click", ()=>{
    if(!isAdmin()) return;
    if(!confirm("Вы уверены? Все участники и результаты будут удалены безвозвратно.")) return;
    if(!confirm("Это последнее предупреждение. Подтвердите полный сброс данных.")) return;
    state = defaultState();
    saveState();
    renderAll();
    showToast("Данные сброшены");
  });

  // ---------------------------------------------------------------
  // Main clock / countdown tick loop
  // ---------------------------------------------------------------
  function tick(){
    const now = Date.now();
    document.getElementById("headerClock").textContent = formatClock(now);
    document.getElementById("currentClock2").textContent = formatClockCenti(now);

    // stop the countdown if the queue has emptied out (nothing left to auto-start)
    if(state.settings.startMode === "auto" && state.countdown.nextStartAt && waitingList().length === 0){
      state.countdown.nextStartAt = null;
      state.countdown.tenSecFired = false;
      state.countdown.zeroFired = false;
      saveState();
    }

    // countdown
    const cdEl = document.getElementById("countdownNum");
    if(state.countdown.nextStartAt){
      const remainMs = state.countdown.nextStartAt - now;
      const remainSec = remainMs/1000;
      cdEl.classList.remove("ready","over");
      if(remainSec <= 0 || state.countdown.zeroFired){
        // timer stops at 00:00 — no negative countdown
        cdEl.textContent = "00:00";
        cdEl.classList.add("over");
        if(!state.countdown.zeroFired){
          state.countdown.zeroFired = true;
          soundGo();
          if(state.selectedNextIds.length > 0){
            // auto-launch whichever participants are currently checked
            doStart();
            showToast("Автостарт: время вышло — выбранные участники запущены");
          } else {
            saveState();
          }
        }
      } else {
        cdEl.textContent = formatMMSS(remainSec);
        if(remainSec <= 10){
          cdEl.classList.add("ready");
          if(!state.countdown.tenSecFired){
            state.countdown.tenSecFired = true;
            soundTenSec();
            saveState();
          }
        }
      }
    } else {
      cdEl.classList.remove("ready","over");
      cdEl.textContent = "—:—";
    }

    // live elapsed times for on-course participants
    document.querySelectorAll("[data-elapsed-for]").forEach(el=>{
      const p = getParticipant(el.dataset.elapsedFor);
      if(p && p.startTime){
        el.textContent = formatDuration(now - p.startTime);
      }
    });

    // "Готовятся" countdown on the Protocol tab — only in auto mode
    const prepCd = document.getElementById("protoPrepCountdown");
    if(prepCd){
      if(state.settings.startMode === "auto" && state.countdown.nextStartAt && !state.countdown.zeroFired){
        const secs = Math.max(0, Math.ceil((state.countdown.nextStartAt - now) / 1000));
        prepCd.textContent = "— старт через " + secs + " с";
      } else {
        prepCd.textContent = "";
      }
    }
  }
  setInterval(tick, 100);

  // ---------------------------------------------------------------
  // Master render
  // ---------------------------------------------------------------
  function renderAll(){
    autoFillSelection();
    renderParticipantsTable();
    renderStartTab();
    renderOnCourseTab();
    renderProtocolTab();
    tick();
  }

  applyTheme();
  applyRoleUI();
  setupRealtimeSync();

})();
