self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
});

self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  var title = data.title || 'Tattoo Diary — Напоминание';
  var options = {
    body: data.body || 'У вас запланирован сеанс',
    icon: '192x192.png',
    badge: '192x192.png',
    tag: data.tag || 'tattoo-diary-push',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

function openSwDb() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('tattoo_diary_sw_db', 1);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'key' });
      }
    };
    req.onsuccess = function(e) {
      resolve(e.target.result);
    };
    req.onerror = function() {
      reject(req.error);
    };
  });
}

function readSwState(db, key) {
  return new Promise(function(resolve) {
    var tx = db.transaction('state', 'readonly');
    var store = tx.objectStore('state');
    var req = store.get(key);
    req.onsuccess = function() {
      resolve(req.result ? req.result.value : null);
    };
    req.onerror = function() {
      resolve(null);
    };
  });
}

function writeSwState(db, key, value) {
  return new Promise(function(resolve) {
    var tx = db.transaction('state', 'readwrite');
    var store = tx.objectStore('state');
    store.put({ key: key, value: value });
    tx.oncomplete = function() { resolve(); };
    tx.onerror = function() { resolve(); };
  });
}

function getLocalDateKey(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function getDayDiffFromToday(dateKey, now) {
  var parts = String(dateKey || '').split('-');
  if (parts.length !== 3) return -1;
  var target = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - todayStart.getTime()) / 86400000);
}

self.addEventListener('periodicsync', function(event) {
  if (event.tag !== 'check-upcoming-sessions') return;
  event.waitUntil((async function() {
    try {
      var db = await openSwDb();
      var snapshot = await readSwState(db, 'diary_snapshot');
      if (!snapshot || !snapshot.settings || !snapshot.settings.enabled) return;

      var settings = snapshot.settings;
      var records = snapshot.records || {};
      var events = snapshot.events || [];
      var sentMap = (await readSwState(db, 'sent_notifications')) || {};

      var now = new Date();
      var nowMinutes = now.getHours() * 60 + now.getMinutes();
      var timeParts = String(settings.notifyTime || '09:00').split(':');
      var targetMinutes = (parseInt(timeParts[0], 10) || 0) * 60 + (parseInt(timeParts[1], 10) || 0);
      if (nowMinutes < targetMinutes) return;

      var changed = false;
      var keys = Object.keys(records);
      for (var i = 0; i < keys.length; i++) {
        var dateKey = keys[i];
        var diffDays = getDayDiffFromToday(dateKey, now);
        if (diffDays < 0) continue;

        var dayRecords = Array.isArray(records[dateKey]) ? records[dateKey] : [];
        for (var j = 0; j < dayRecords.length; j++) {
          var rec = dayRecords[j];
          if (rec.notify === false) continue;

          var rType = rec.recordType || 'tattoo';
          if (rType === 'tattoo' && settings.notifyTattoo === false) continue;
          if (rType === 'piercing' && settings.notifyPiercing === false) continue;
          if (rType === 'consultation' && settings.notifyConsultation === false) continue;

          var baseDays = (rec.notifyDaysBefore !== null && rec.notifyDaysBefore !== undefined && rec.notifyDaysBefore !== '')
            ? Number(rec.notifyDaysBefore)
            : Number(settings.daysBefore || 0);
          var allowedDays = [baseDays];
          if (settings.alsoSameDay && baseDays > 0) allowedDays.push(0);

          if (allowedDays.indexOf(diffDays) === -1) continue;

          var sentKey = 'rec_' + rec.id + '_' + dateKey + '_d' + diffDays;
          if (sentMap[sentKey]) continue;

          var typeLabel = rType === 'piercing' ? 'Пирсинг' : (rType === 'consultation' ? 'Консультация' : 'Тату-сеанс');
          var whenLabel = diffDays === 0 ? 'Сегодня' : (diffDays === 1 ? 'Завтра' : 'Через ' + diffDays + ' дн.');
          var title = whenLabel + ': ' + typeLabel + ' — ' + (rec.name || 'Клиент');
          var bodyParts = [];
          if (rec.time) bodyParts.push('Время: ' + rec.time);
          if (rec.work) bodyParts.push(rec.work);
          if (rType === 'tattoo' && rec.sketchReady === false) bodyParts.push('Эскиз не готов');

          await self.registration.showNotification(title, {
            body: bodyParts.join(' · ') || ('Дата: ' + dateKey),
            icon: '192x192.png',
            badge: '192x192.png',
            tag: sentKey,
            renotify: true
          });

          sentMap[sentKey] = Date.now();
          changed = true;
        }
      }

      if (settings.notifyEvents && Array.isArray(events)) {
        for (var eIdx = 0; eIdx < events.length; eIdx++) {
          var ev = events[eIdx];
          var evDiff = getDayDiffFromToday(ev.startDate, now);
          if (evDiff < 0) continue;
          var evAllowed = [Number(settings.daysBefore || 0)];
          if (settings.alsoSameDay && Number(settings.daysBefore || 0) > 0) evAllowed.push(0);
          if (evAllowed.indexOf(evDiff) === -1) continue;
          var evSentKey = 'evt_' + ev.id + '_' + ev.startDate + '_d' + evDiff;
          if (sentMap[evSentKey]) continue;

          var evWhen = evDiff === 0 ? 'Сегодня' : (evDiff === 1 ? 'Завтра' : 'Через ' + evDiff + ' дн.');
          await self.registration.showNotification(evWhen + ': Событие — ' + (ev.title || ''), {
            body: (ev.time ? 'Время: ' + ev.time + ' · ' : '') + (ev.note || ('Дата: ' + ev.startDate)),
            icon: '192x192.png',
            badge: '192x192.png',
            tag: evSentKey,
            renotify: true
          });
          sentMap[evSentKey] = Date.now();
          changed = true;
        }
      }

      if (changed) {
        await writeSwState(db, 'sent_notifications', sentMap);
      }
    } catch (err) {
      // ignore background sync errors silently
    }
  })());
});
