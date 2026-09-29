const CACHE = "mahami-v9";
const SCHEDULE_DB = "mahami-notify-db";
const SCHEDULE_STORE = "schedule";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => checkScheduledNotifications())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});

function openScheduleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SCHEDULE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SCHEDULE_STORE)) {
        db.createObjectStore(SCHEDULE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readSchedule() {
  const db = await openScheduleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCHEDULE_STORE, "readonly");
    const store = tx.objectStore(SCHEDULE_STORE);
    const req = store.get("current");
    req.onsuccess = () => resolve(req.result || { events: [], fired: [] });
    req.onerror = () => reject(req.error);
  });
}

async function writeSchedule(data) {
  const db = await openScheduleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCHEDULE_STORE, "readwrite");
    const store = tx.objectStore(SCHEDULE_STORE);
    const req = store.put(data, "current");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function absoluteUrl(path) {
  try {
    return new URL(path, self.registration.scope).href;
  } catch {
    return path;
  }
}

async function showSystemNotification(title, body, tag, extra = {}) {
  const opts = {
    body: body || "حان وقت التذكير من مهامي",
    icon: absoluteUrl("./icons/icon-192.png"),
    badge: absoluteUrl("./icons/icon-192.png"),
    image: undefined,
    tag: tag || `mahami-${Date.now()}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [220, 100, 220, 100, 320],
    lang: "ar",
    dir: "rtl",
    timestamp: Date.now(),
    actions: [
      { action: "open", title: "فتح" },
      { action: "dismiss", title: "إغلاق" },
    ],
    data: { url: "./index.html", ...(extra.data || {}) },
  };

  // بعض المتصفحات تدعم إبقاء الإشعار ظاهراً على شاشة القفل أكثر
  if ("TimestampTrigger" in self && extra.triggerAt) {
    try {
      opts.showTrigger = new self.TimestampTrigger(extra.triggerAt);
    } catch { /* ignore unsupported */ }
  }

  await self.registration.showNotification(title, opts);
}

async function checkScheduledNotifications() {
  try {
    const schedule = await readSchedule();
    const events = Array.isArray(schedule.events) ? schedule.events : [];
    const fired = new Set(Array.isArray(schedule.fired) ? schedule.fired : []);
    const now = Date.now();
    let changed = false;

    for (const event of events) {
      if (!event || !event.id || !event.at) continue;
      if (fired.has(event.id)) continue;
      if (event.at > now) continue;
      // نافذة الإرسال: خلال آخر 10 دقائق حتى لا تفوت عند تأخر الاستيقاظ
      if (now - event.at > 10 * 60 * 1000) {
        fired.add(event.id);
        changed = true;
        continue;
      }
      const prefix = event.priority === "urgent" ? "🔥 عاجل: " : "⏰ تذكير: ";
      await showSystemNotification(
        prefix + (event.title || "تذكير"),
        event.body || "حان وقت التذكير من تطبيق مهامي",
        event.id,
        { data: { reminderId: event.id } }
      );
      fired.add(event.id);
      changed = true;
    }

    if (changed) {
      const nextFired = [...fired].slice(-300);
      await writeSchedule({ ...schedule, events, fired: nextFired, updatedAt: now });
    }
  } catch (err) {
    console.warn("notify check failed", err);
  }
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SYNC_SCHEDULE") {
    event.waitUntil(
      writeSchedule({
        events: data.events || [],
        fired: data.fired || [],
        updatedAt: Date.now(),
      }).then(() => checkScheduledNotifications())
    );
  }
  if (data.type === "CHECK_DUE") {
    event.waitUntil(checkScheduledNotifications());
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "mahami-reminders") {
    event.waitUntil(checkScheduledNotifications());
  }
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action;
  event.notification.close();
  if (action === "dismiss") return;
  const target = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "NOTIFICATION_CLICK", data: event.notification.data || {} });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// فحص دوري خفيف أثناء بقاء الـ SW حياً
setInterval(() => {
  checkScheduledNotifications();
}, 30000);
