// 纯网页版后端：在 GitHub Pages 等没有服务器的地方启用
// 数据存在本浏览器（localStorage + IndexedDB 存照片），AI 批改由浏览器直接调用 Claude API
import { createStore } from "./shared/store.js";

const DB_KEY = "hw-grader:db";
const SETTINGS_KEY = "hw-grader:settings";
const SESSION_KEY = "hw-grader:api-key"; // 不勾选「记住 Key」时只存在本次会话

function readJSON(storage, key, fallback) {
  try {
    return JSON.parse(storage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch (err) {
    console.warn("浏览器存储写入失败：", err);
  }
}

// ---------- IndexedDB：作业照片 ----------
let idbPromise = null;
function idb() {
  idbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("hw-grader", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("images");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
async function idbDo(mode, fn) {
  const tx = (await idb()).transaction("images", mode);
  const req = fn(tx.objectStore("images"));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const urlCache = new Map();
export async function imageUrl(name) {
  if (!urlCache.has(name)) {
    const blob = await idbDo("readonly", (s) => s.get(name));
    urlCache.set(name, blob ? URL.createObjectURL(blob) : "");
  }
  return urlCache.get(name);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

let store = null;

export function init() {
  const db = readJSON(localStorage, DB_KEY, { classes: [], assignments: [], submissions: [] });
  const settings = { apiKey: "", baseURL: "", effort: "high", remember: true, ...readJSON(localStorage, SETTINGS_KEY, {}) };
  if (!settings.remember) settings.apiKey = readJSON(sessionStorage, SESSION_KEY, "");

  store = createStore({
    db,
    settings,
    browser: true,
    saveDb: () => write(localStorage, DB_KEY, JSON.stringify(db)),
    saveSettings: () => {
      const { apiKey, ...rest } = settings;
      write(localStorage, SETTINGS_KEY, JSON.stringify(settings.remember ? settings : rest));
      write(sessionStorage, SESSION_KEY, settings.remember ? null : JSON.stringify(apiKey));
    },
    saveImage: async (file) => {
      const ext = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[file.type] || "jpg";
      const name = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
      await idbDo("readwrite", (s) => s.put(file, name));
      return name;
    },
    readImage: async (name) => {
      const blob = await idbDo("readonly", (s) => s.get(name));
      if (!blob) throw new Error("找不到这张作业照片，请重新上传");
      return { base64: await blobToBase64(blob), mediaType: blob.type || "image/jpeg" };
    },
    deleteImage: async (name) => {
      await idbDo("readwrite", (s) => s.delete(name));
      if (urlCache.get(name)) URL.revokeObjectURL(urlCache.get(name));
      urlCache.delete(name);
    }
  });
}

export function handle(method, path, body, file) {
  return store.handle(method, path, body, file);
}
