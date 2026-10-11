const diaryGate = document.querySelector("#diary-gate");
const diaryGateForm = document.querySelector("#diary-gate-form");
const diaryGateTitle = document.querySelector("#diary-gate-title");
const diaryGateCopy = document.querySelector("#diary-gate-copy");
const diaryGateButton = document.querySelector("#diary-gate-button");
const diaryGateStatus = document.querySelector("#diary-gate-status");
const diaryPassphrase = document.querySelector("#diary-passphrase");
const diaryPassphraseConfirm = document.querySelector("#diary-passphrase-confirm");
const diaryConfirmRow = document.querySelector("#diary-confirm-row");
const diaryForgetButton = document.querySelector("#diary-forget-button");
const diaryUnlocked = document.querySelector("#diary-unlocked");
const diaryLockButton = document.querySelector("#diary-lock-button");
const diaryEraseButton = document.querySelector("#diary-erase-button");
const diaryEntryForm = document.querySelector("#diary-entry-form");
const diaryText = document.querySelector("#diary-text");
const diaryMood = document.querySelector("#diary-mood");
const diaryCount = document.querySelector("#diary-count");
const diarySaveButton = document.querySelector("#diary-save-button");
const diaryWorkStatus = document.querySelector("#diary-work-status");
const diaryEntryCount = document.querySelector("#diary-entry-count");
const diaryClearButton = document.querySelector("#diary-clear-button");
const diaryList = document.querySelector("#diary-list");
const diaryEmpty = document.querySelector("#diary-empty");

const DIARY_STORAGE_KEY = "idfk-private-diary-v1";
const DIARY_ITERATIONS = 310000;
const DIARY_CHECK_TEXT = "idfk-private-diary-check-v1";

let diaryEnvelope = null;
let diaryKey = null;
let diaryEntries = [];
let diaryBusy = false;
let diaryGateBusy = false;
let diarySessionToken = 0;
let diaryGateToken = 0;

const DIARY_MOODS = new Set(["just noticing", "hopeful", "tender", "restless", "tired", "proud"]);

function isDiaryCiphertext(record) {
  return Boolean(
    record &&
    typeof record.iv === "string" && record.iv.length === 16 &&
    typeof record.data === "string" && record.data.length > 0 && record.data.length <= 5000
  );
}

function readDiaryEnvelope() {
  let raw;
  try {
    raw = localStorage.getItem(DIARY_STORAGE_KEY);
  } catch {
    return { kind: "storage-error" };
  }
  if (!raw) return { kind: "new" };

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }

  const valid = saved &&
    saved.version === 1 &&
    Number.isInteger(saved.iterations) && saved.iterations >= 100000 && saved.iterations <= 1000000 &&
    typeof saved.salt === "string" && saved.salt.length === 24 &&
    isDiaryCiphertext(saved.check) &&
    Array.isArray(saved.entries) &&
    saved.entries.every((record) => record && typeof record.id === "string" && record.id.length <= 80 && isDiaryCiphertext(record));
  return valid ? { kind: "saved", envelope: saved } : { kind: "corrupt" };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function base64ToBytes(encoded) {
  const binary = window.atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveDiaryKey(passphrase, salt, iterations) {
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptDiaryText(value, key) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value)
  );
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decryptDiaryText(record, key) {
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.data)
  );
  return new TextDecoder().decode(decrypted);
}

function configureDiaryGate() {
  const state = readDiaryEnvelope();
  diaryEnvelope = state.kind === "saved" ? state.envelope : null;
  diaryGate.hidden = false;
  diaryUnlocked.hidden = true;
  diaryGateForm.hidden = false;
  diaryGateStatus.textContent = "";
  diaryForgetButton.hidden = state.kind !== "saved" && state.kind !== "corrupt";
  diaryForgetButton.textContent = state.kind === "corrupt"
    ? "erase damaged notebook"
    : "forgot your passphrase? erase this notebook";
  diaryConfirmRow.hidden = false;
  diaryPassphrase.value = "";
  diaryPassphraseConfirm.value = "";
  diaryPassphrase.disabled = false;
  diaryPassphraseConfirm.disabled = false;
  diaryPassphraseConfirm.required = true;
  diaryPassphrase.autocomplete = "new-password";
  diaryGateForm.classList.remove("is-unlocking");
  diaryGateButton.querySelector("span").textContent = "create the notebook";

  if (state.kind === "storage-error") {
    diaryGateTitle.textContent = "This browser blocks notebook storage";
    diaryGateCopy.textContent = "The encrypted notebook needs local browser storage. Nothing was saved; check this browser’s privacy settings and try again.";
    diaryGateForm.hidden = true;
    diaryGateStatus.textContent = "Notebook storage is unavailable.";
    return;
  }

  if (state.kind === "corrupt") {
    diaryGateTitle.textContent = "The notebook data looks unfamiliar";
    diaryGateCopy.textContent = "This saved notebook cannot be opened by this version. You can erase it to begin again, but its pages cannot be recovered.";
    diaryGateForm.hidden = true;
    return;
  }

  if (!window.crypto || !window.crypto.subtle || !window.crypto.getRandomValues) {
    diaryGateTitle.textContent = "A browser with encryption is needed";
    diaryGateCopy.textContent = "This notebook uses built-in browser encryption. Open the site over HTTPS or localhost in a modern browser; your thoughts will not be saved unencrypted.";
    diaryGateForm.hidden = true;
    return;
  }

  if (state.kind === "saved") {
    diaryGateTitle.textContent = "Welcome back to your notebook";
    diaryGateCopy.textContent = "Enter the passphrase you chose. There is no reset or recovery key.";
    diaryGateForm.classList.add("is-unlocking");
    diaryConfirmRow.hidden = true;
    diaryPassphraseConfirm.disabled = true;
    diaryPassphraseConfirm.required = false;
    diaryPassphrase.autocomplete = "current-password";
    diaryGateButton.querySelector("span").textContent = "unlock the notebook";
  } else {
    diaryGateTitle.textContent = "Start a private notebook";
    diaryGateCopy.textContent = "Choose a passphrase only you know. Your words are encrypted in this browser; they never leave this device.";
  }
}

function renderDiaryPages() {
  diaryList.replaceChildren();
  diaryEntries.forEach((entry) => {
    const date = new Date(entry.createdAt);
    const dateLabel = new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    }).format(date);
    const item = document.createElement("li");
    item.className = "diary-page";

    const header = document.createElement("div");
    header.className = "diary-page-head";
    const time = document.createElement("time");
    time.className = "diary-page-date";
    time.dateTime = date.toISOString();
    time.textContent = dateLabel;
    const mood = document.createElement("span");
    mood.className = "diary-page-mood";
    mood.textContent = entry.mood;
    const remove = document.createElement("button");
    remove.className = "diary-delete-entry";
    remove.type = "button";
    remove.dataset.diaryDelete = entry.id;
    remove.disabled = diaryBusy;
    remove.textContent = "delete";
    remove.setAttribute("aria-label", `Delete diary page from ${dateLabel}`);
    header.append(time, mood, remove);

    const text = document.createElement("p");
    text.className = "diary-page-text";
    text.textContent = entry.text;
    item.append(header, text);
    diaryList.append(item);
  });
  diaryEntryCount.textContent = String(diaryEntries.length);
  diaryEmpty.hidden = diaryEntries.length > 0;
  diaryClearButton.hidden = diaryEntries.length === 0;
}

function openDiarySession(entries, key) {
  diarySessionToken += 1;
  diaryKey = key;
  diaryEntries = entries.sort((first, second) => second.createdAt - first.createdAt);
  diaryGate.hidden = true;
  diaryUnlocked.hidden = false;
  diaryGateStatus.textContent = "";
  diaryWorkStatus.textContent = "";
  diaryText.value = "";
  diaryCount.textContent = "0 / 1400";
  renderDiaryPages();
  diaryText.focus();
}

function setDiaryWorkBusy(busy) {
  diaryBusy = busy;
  diaryUnlocked.setAttribute("aria-busy", String(busy));
  diaryText.disabled = busy;
  diaryMood.disabled = busy;
  diarySaveButton.disabled = busy;
  diaryClearButton.disabled = busy;
  diaryEraseButton.disabled = busy;
  diaryLockButton.disabled = busy;
  diaryList.querySelectorAll(".diary-delete-entry").forEach((button) => {
    button.disabled = busy;
  });
}

function lockDiarySession() {
  diarySessionToken += 1;
  diaryGateToken += 1;
  diaryGateBusy = false;
  diaryGateButton.disabled = false;
  diaryPassphrase.disabled = false;
  diaryPassphraseConfirm.disabled = diaryConfirmRow.hidden;
  if (diaryBusy) setDiaryWorkBusy(false);
  diaryKey = null;
  diaryEntries = [];
  diaryList.replaceChildren();
  diaryText.value = "";
  diaryCount.textContent = "0 / 1400";
  diaryEntryCount.textContent = "0";
  diaryWorkStatus.textContent = "";
  diaryUnlocked.hidden = true;
  configureDiaryGate();
  diaryGateStatus.textContent = "Notebook locked. Your pages are sealed again.";
}

function eraseWholeDiary() {
  if (diaryBusy || diaryGateBusy) return;
  const confirmed = window.confirm("Erase this entire encrypted notebook? This cannot be undone.");
  if (!confirmed) return;

  try {
    localStorage.removeItem(DIARY_STORAGE_KEY);
    diaryKey = null;
    diaryEntries = [];
    diaryList.replaceChildren();
    diaryText.value = "";
    diaryCount.textContent = "0 / 1400";
    diaryUnlocked.hidden = true;
    configureDiaryGate();
    diaryGateStatus.textContent = "The notebook is erased. You can start a fresh one whenever you like.";
  } catch {
    diaryWorkStatus.textContent = "The notebook could not be erased from this browser.";
  }
}

diaryGateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (diaryGateBusy) return;
  const isUnlocking = Boolean(diaryEnvelope);
  const passphrase = diaryPassphrase.value;
  if (passphrase.length < 8) {
    diaryGateStatus.textContent = "Use a passphrase with at least 8 characters.";
    diaryPassphrase.focus();
    return;
  }

  if (!isUnlocking && passphrase !== diaryPassphraseConfirm.value) {
    diaryGateStatus.textContent = "Those passphrases don’t match yet.";
    diaryPassphraseConfirm.focus();
    return;
  }

  const operation = ++diaryGateToken;
  diaryGateBusy = true;
  diaryGateButton.disabled = true;
  diaryPassphrase.disabled = true;
  diaryPassphraseConfirm.disabled = true;
  diaryGateStatus.textContent = isUnlocking ? "Opening your notebook…" : "Making your private key…";

  try {
    if (isUnlocking) {
      const key = await deriveDiaryKey(passphrase, base64ToBytes(diaryEnvelope.salt), diaryEnvelope.iterations);
      if (operation !== diaryGateToken) return;
      const checkText = await decryptDiaryText(diaryEnvelope.check, key);
      if (operation !== diaryGateToken) return;
      if (checkText !== DIARY_CHECK_TEXT) throw new Error("The passphrase did not match.");
      const entries = await Promise.all(diaryEnvelope.entries.map(async (record) => {
        const entry = JSON.parse(await decryptDiaryText(record, key));
        const validDate = entry && Number.isFinite(entry.createdAt) && !Number.isNaN(new Date(entry.createdAt).getTime());
        if (!entry || entry.id !== record.id || typeof entry.text !== "string" || entry.text.length > 1400 || !validDate || !DIARY_MOODS.has(entry.mood)) {
          throw new Error("A notebook page could not be read.");
        }
        return entry;
      }));
      if (operation !== diaryGateToken) return;
      diaryPassphrase.value = "";
      openDiarySession(entries, key);
    } else {
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveDiaryKey(passphrase, salt, DIARY_ITERATIONS);
      if (operation !== diaryGateToken) return;
      const check = await encryptDiaryText(DIARY_CHECK_TEXT, key);
      if (operation !== diaryGateToken) return;
      const envelope = {
        version: 1,
        iterations: DIARY_ITERATIONS,
        salt: bytesToBase64(salt),
        check,
        entries: []
      };
      localStorage.setItem(DIARY_STORAGE_KEY, JSON.stringify(envelope));
      diaryEnvelope = envelope;
      diaryPassphrase.value = "";
      diaryPassphraseConfirm.value = "";
      openDiarySession([], key);
    }
  } catch {
    if (operation !== diaryGateToken) return;
    diaryPassphrase.value = "";
    diaryGateStatus.textContent = isUnlocking
      ? "That passphrase didn’t unlock the notebook. Check it and try again."
      : "The notebook couldn’t be created. Check browser storage and try again.";
  } finally {
    if (operation === diaryGateToken) {
      diaryGateBusy = false;
      diaryGateButton.disabled = false;
      diaryPassphrase.disabled = false;
      diaryPassphraseConfirm.disabled = diaryConfirmRow.hidden;
    }
  }
});

diaryPassphrase.addEventListener("input", () => {
  diaryGateStatus.textContent = "";
});
diaryPassphraseConfirm.addEventListener("input", () => {
  diaryGateStatus.textContent = "";
});

diaryForgetButton.addEventListener("click", eraseWholeDiary);
diaryEraseButton.addEventListener("click", eraseWholeDiary);
diaryLockButton.addEventListener("click", () => {
  if (diaryBusy) return;
  if (diaryText.value.trim() && !window.confirm("Locking will clear this unsaved thought. Lock the notebook anyway?")) return;
  lockDiarySession();
});

diaryText.addEventListener("input", () => {
  diaryCount.textContent = `${diaryText.value.length} / 1400`;
  diaryWorkStatus.textContent = "";
});

diaryEntryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (diaryBusy || !diaryKey || !diaryEnvelope) return;
  const text = diaryText.value.trim();
  if (!text) {
    diaryText.focus();
    return;
  }

  const randomId = window.crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(randomId, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const entry = { id, createdAt: Date.now(), mood: diaryMood.value, text };
  const session = diarySessionToken;
  const activeKey = diaryKey;
  const activeEnvelope = diaryEnvelope;
  setDiaryWorkBusy(true);
  diaryWorkStatus.textContent = "Tucking this page away…";

  try {
    const encrypted = await encryptDiaryText(JSON.stringify(entry), activeKey);
    if (session !== diarySessionToken || activeKey !== diaryKey || diaryUnlocked.hidden) return;
    const nextEnvelope = { ...activeEnvelope, entries: [{ id, ...encrypted }, ...activeEnvelope.entries] };
    localStorage.setItem(DIARY_STORAGE_KEY, JSON.stringify(nextEnvelope));
    diaryEnvelope = nextEnvelope;
    diaryEntries.unshift(entry);
    diaryText.value = "";
    diaryMood.value = "just noticing";
    diaryCount.textContent = "0 / 1400";
    renderDiaryPages();
    diaryWorkStatus.textContent = "Kept close. Take a breath.";
  } catch {
    if (session === diarySessionToken) diaryWorkStatus.textContent = "Couldn’t save this page. Your words are still here; try again.";
  } finally {
    setDiaryWorkBusy(false);
  }
});

diaryList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-diary-delete]");
  if (!button || diaryBusy || !diaryEnvelope) return;
  const id = button.dataset.diaryDelete;
  const nextPages = diaryEntries.filter((entry) => entry.id !== id);
  const nextRecords = diaryEnvelope.entries.filter((record) => record.id !== id);
  if (nextPages.length === diaryEntries.length) return;

  setDiaryWorkBusy(true);
  diaryWorkStatus.textContent = "Sealing the edit…";
  try {
    const nextEnvelope = { ...diaryEnvelope, entries: nextRecords };
    localStorage.setItem(DIARY_STORAGE_KEY, JSON.stringify(nextEnvelope));
    diaryEnvelope = nextEnvelope;
    diaryEntries = nextPages;
    renderDiaryPages();
    diaryWorkStatus.textContent = "That page is gone for good.";
  } catch {
    diaryWorkStatus.textContent = "Couldn’t update the notebook. Try again.";
  } finally {
    setDiaryWorkBusy(false);
  }
});

diaryClearButton.addEventListener("click", () => {
  if (diaryBusy || !diaryEnvelope || !window.confirm("Erase every page but keep your notebook key? This cannot be undone.")) return;
  setDiaryWorkBusy(true);
  try {
    const nextEnvelope = { ...diaryEnvelope, entries: [] };
    localStorage.setItem(DIARY_STORAGE_KEY, JSON.stringify(nextEnvelope));
    diaryEnvelope = nextEnvelope;
    diaryEntries = [];
    renderDiaryPages();
    diaryWorkStatus.textContent = "A clean page. The old ones are gone.";
  } catch {
    diaryWorkStatus.textContent = "Couldn’t clear the pages from this browser.";
  } finally {
    setDiaryWorkBusy(false);
  }
});

window.addEventListener("pagehide", () => {
  if (!diaryUnlocked.hidden) {
    lockDiarySession();
  } else {
    diaryGateToken += 1;
    diaryGateBusy = false;
    diaryGateButton.disabled = false;
    diaryPassphrase.disabled = false;
    diaryPassphraseConfirm.disabled = diaryConfirmRow.hidden;
  }
  diaryPassphrase.value = "";
  diaryPassphraseConfirm.value = "";
});
