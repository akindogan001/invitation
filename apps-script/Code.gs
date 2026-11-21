/**
 * Esra & Akın nişan davetiyesi — fotoğraf / video yükleme servisi
 *
 * KURULUM / GÜNCELLEME
 * 1. Bu kodu Apps Script editöründeki Code.gs'nin yerine yapıştırın ve kaydedin.
 * 2. Project Settings → "Show appsscript.json manifest file in editor" işaretleyin; appsscript.json'a
 *    bu klasördeki dosyadaki "oauthScopes" listesini ekleyin (drive + script.external_request).
 *    Bu liste yoksa Drive'a parçalı yükleme 403 "insufficient authentication scopes" verir.
 *    Sonra editörde diagnoseDrive fonksiyonunu seçip Çalıştır'a basın; izin ekranında TÜM kutuları işaretleyin.
 *    (Bu sürüm Drive'a parçalı yükleme için UrlFetchApp kullanıyor; "harici istek" izni yeni.)
 * 3. Deploy → Manage deployments → mevcut deployment'ta kalem (Edit) → Version: "New version" → Deploy.
 *    Execute as: Me · Who has access: Anyone
 *    YENİ deployment oluşturmayın: /exec URL'si değişir ve davetiyedeki adres eskide kalır.
 *
 * AKIŞ
 * - init : dosya bilgisi doğrulanır, Drive'da "resumable upload" oturumu açılır.
 * - chunk: dosya parça parça (base64) gelir, sunucu her parçayı Drive oturumuna iletir.
 * Böylece büyük videolar da yüklenebilir ve tarayıcı Drive erişim anahtarını hiç görmez.
 */

const DRIVE_FOLDER_ID = '1olplYBoWOUxNHYhafFMzH-LJd5mUqJZP';
const EVENT_CODE = 'esra-akin-0512';                       // index.html'deki EVENT_CODE ile aynı olmalı
const UPLOAD_OPENS = new Date('2026-11-21T00:00:00+03:00');  // test için bugünden açık
const UPLOAD_CLOSES = new Date('2027-01-05T23:59:59+03:00');
const MAX_FILE_BYTES = 500 * 1024 * 1024;                   // index.html'deki MAX_FILE_SIZE ile aynı olmalı
const CHUNK_BYTES = 8 * 1024 * 1024;                        // 256 KB'nin katı olmalı (Drive kuralı)
const MAX_NEW_FILES_PER_MINUTE = 60;
const MAX_NEW_FILES_PER_DAY = 3000;
const SESSION_TTL_SEC = 6 * 60 * 60;                        // CacheService üst sınırı
const TZ = 'Europe/Istanbul';

const ALLOWED_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm'
};

/* ---------------- Web app giriş noktaları ---------------- */

function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.code !== EVENT_CODE) throw userError('Geçersiz istek.', 'bad_code');
    const now = new Date();
    if (now < UPLOAD_OPENS || now > UPLOAD_CLOSES) throw userError('Yükleme şu anda kapalı.', 'closed');
    switch (p.action) {
      case 'init': return json(initUpload(p));
      case 'chunk': return json(uploadChunk(p));
      default: throw userError('Geçersiz istek.', 'bad_action');
    }
  } catch (err) {
    if (err && err.userMessage) {
      return json({ ok: false, error: err.userMessage, code: err.code, retry: err.retry });
    }
    console.error(err && err.stack ? err.stack : err);
    return json({ ok: false, error: 'Sunucuda bir hata oluştu.', code: 'server_error', retry: true });
  }
}

function doGet() {
  return ContentService.createTextOutput('OK');
}

/* ---------------- İşlemler ---------------- */

function initUpload(p) {
  const uploadId = cleanId(p.uploadId);
  const cache = CacheService.getScriptCache();

  // Aynı uploadId ile tekrar gelen init (ağ hatası sonrası tekrar deneme): yeni dosya açma, kaldığı yerden devam et.
  const existing = readState(cache, uploadId);
  if (existing) return stateResponse(existing);

  const size = Number(p.size);
  if (!(size > 0)) throw userError('Dosya boş görünüyor.', 'empty');
  if (size > MAX_FILE_BYTES) {
    throw userError('Dosya çok büyük (en fazla ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB).', 'too_large');
  }

  const originalName = String(p.fileName || '').slice(0, 200);
  const extMatch = originalName.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  if (!ALLOWED_EXT[ext]) throw userError('Yalnızca fotoğraf ve video yüklenebilir.', 'bad_type');

  const reportedMime = String(p.mimeType || '').toLowerCase();
  const isMediaMime = /^(image|video)\/[a-z0-9.+-]+$/.test(reportedMime);
  if (reportedMime && !isMediaMime && reportedMime !== 'application/octet-stream') {
    throw userError('Yalnızca fotoğraf ve video yüklenebilir.', 'bad_type');
  }
  const mimeType = isMediaMime ? reportedMime : ALLOWED_EXT[ext];

  checkRateLimit(cache);

  const guestRaw = String(p.guestName || '').trim().slice(0, 60);
  const baseName = cleanName(originalName.replace(/\.[^.]*$/, '')) || 'dosya';
  const name = [Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss'), cleanName(guestRaw), baseName]
    .filter(Boolean).join('_') + '.' + ext;

  const url = createSession(
    { name: name, mimeType: mimeType, parents: [DRIVE_FOLDER_ID], description: guestRaw ? 'Gönderen: ' + guestRaw : '' },
    size
  );
  const state = { url: url, size: size, received: 0, name: name };
  writeState(cache, uploadId, state);
  return stateResponse(state);
}

function uploadChunk(p) {
  const uploadId = cleanId(p.uploadId);
  const cache = CacheService.getScriptCache();
  const state = readState(cache, uploadId);
  if (!state) throw userError('Yükleme oturumu bulunamadı.', 'no_session');
  if (state.fileId) return stateResponse(state);

  // Daha önce işlenmiş (cevabı kaybolmuş) ya da sıra dışı parça: Drive'a tekrar gönderme,
  // istemciye güncel konumu bildir, oradan devam etsin.
  const offset = Number(p.offset);
  if (offset !== state.received) return stateResponse(state);

  const bytes = Utilities.base64Decode(String(p.data || ''));
  const end = offset + bytes.length;
  const isLast = end === state.size;
  if (!bytes.length || end > state.size || (!isLast && bytes.length % (256 * 1024) !== 0)) {
    throw userError('Geçersiz dosya parçası.', 'bad_chunk');
  }

  const result = putChunk(state.url, bytes, offset, state.size);
  if (result.expired) {
    cache.remove(stateKey(uploadId));
    throw userError('Yükleme oturumu sona erdi.', 'no_session');
  }
  state.received = result.received;
  if (result.fileId) state.fileId = result.fileId;
  writeState(cache, uploadId, state);
  return stateResponse(state);
}

/* ---------------- Drive resumable upload ---------------- */

function createSession(metadata, size) {
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify(metadata),
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': metadata.mimeType,
        'X-Upload-Content-Length': String(size)
      },
      muteHttpExceptions: true
    }
  );
  const location = header(res, 'Location');
  if (res.getResponseCode() !== 200 || !location) {
    console.error('createSession ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 500));
    throw userError('Yükleme başlatılamadı.', 'init_failed', true);
  }
  return location;
}

function putChunk(sessionUrl, bytes, offset, size) {
  const res = UrlFetchApp.fetch(sessionUrl, {
    method: 'put',
    contentType: 'application/octet-stream',
    payload: bytes,
    headers: { 'Content-Range': 'bytes ' + offset + '-' + (offset + bytes.length - 1) + '/' + size },
    muteHttpExceptions: true,
    followRedirects: false
  });
  const code = res.getResponseCode();
  if (code === 200 || code === 201) {
    return { received: size, fileId: JSON.parse(res.getContentText()).id };
  }
  if (code === 308) {                       // "Resume Incomplete": Range = bytes=0-N
    const range = header(res, 'Range');
    return { received: range ? Number(String(range).split('-')[1]) + 1 : 0 };
  }
  if (code === 404 || code === 410) return { expired: true };
  console.error('putChunk ' + code + ' ' + res.getContentText().slice(0, 500));
  throw userError('Dosya parçası yüklenemedi.', 'chunk_failed', true);
}

/* ---------------- Hız sınırı ---------------- */

function checkRateLimit(cache) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const minuteKey = 'rl_m_' + Math.floor(Date.now() / 60000);
    const dayKey = 'rl_d_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
    const perMinute = Number(cache.get(minuteKey) || 0);
    const perDay = Number(props.getProperty(dayKey) || 0);
    if (perMinute >= MAX_NEW_FILES_PER_MINUTE) {
      throw userError('Şu anda çok fazla yükleme var, birazdan tekrar deneyin.', 'rate_limited', true);
    }
    if (perDay >= MAX_NEW_FILES_PER_DAY) throw userError('Bugünlük yükleme sınırına ulaşıldı.', 'daily_limit');
    cache.put(minuteKey, String(perMinute + 1), 120);
    props.setProperty(dayKey, String(perDay + 1));
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Yardımcılar ---------------- */

function stateKey(uploadId) { return 'up_' + uploadId; }

function readState(cache, uploadId) {
  const raw = cache.get(stateKey(uploadId));
  return raw ? JSON.parse(raw) : null;
}

function writeState(cache, uploadId, state) {
  cache.put(stateKey(uploadId), JSON.stringify(state), SESSION_TTL_SEC);
}

function stateResponse(state) {
  return { ok: true, received: state.received, size: state.size, done: !!state.fileId, chunkBytes: CHUNK_BYTES };
}

function cleanId(id) {
  const s = String(id || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s)) throw userError('Geçersiz istek.', 'bad_id');
  return s;
}

/** Dosya adında sorun çıkaracak karakterleri atar; Türkçe harfler kalır. */
function cleanName(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|#%{}~&^`\[\]\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}

function header(res, name) {
  const headers = res.getAllHeaders();
  const key = Object.keys(headers).find(function (k) { return k.toLowerCase() === name.toLowerCase(); });
  if (!key) return '';
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function userError(message, code, retry) {
  const err = new Error(message);
  err.userMessage = message;
  err.code = code;
  err.retry = !!retry;
  return err;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- Elle test: editörde seçip Çalıştır'a basın ---------------- */

function diagnoseDrive() {
  console.log('SCRIPT HESABI: ' + Session.getEffectiveUser().getEmail());
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  console.log('KLASOR ADI: ' + folder.getName());

  // Parçalı yükleme yolunu uçtan uca dener (3 parçalı küçük bir metin dosyası).
  const text = 'Apps Script parçalı yükleme testi ' + new Date().toISOString() + '\n';
  const chunk = 256 * 1024;
  const bytes = Utilities.newBlob(new Array(chunk * 2 + 1).join('x') + text).getBytes();
  const url = createSession(
    { name: 'UPLOAD_TEST_' + Date.now() + '.txt', mimeType: 'text/plain', parents: [DRIVE_FOLDER_ID] },
    bytes.length
  );
  let offset = 0;
  let result = null;
  while (offset < bytes.length) {
    const part = bytes.slice(offset, Math.min(offset + chunk, bytes.length));
    result = putChunk(url, part, offset, bytes.length);
    if (result.expired) throw new Error('Oturum beklenmedik şekilde kapandı');
    offset = result.received;
  }
  console.log('DOSYA OLUSTURULDU: ' + DriveApp.getFileById(result.fileId).getUrl());
  console.log('Test dosyasını klasörden silebilirsiniz.');
}
