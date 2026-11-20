// Service worker tối giản: chỉ để trình duyệt cho phép "Cài đặt app" / mở toàn màn hình.
// Không lưu cache – dữ liệu tiền nong luôn lấy mới từ máy chủ.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
