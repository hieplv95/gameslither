# GameSlither — game rắn online kiểu slither.io

Hai chế độ:
- **Chơi miễn phí**: vào nhanh phòng công khai, chọn phòng trong danh sách, hoặc tạo phòng riêng và mời bạn bè bằng mã 4 ký tự. Có bot.
- **Chơi mất phí**: chọn mức cược 1 / 5 / 10 USDT; hệ thống tự xếp phòng (không cho chọn phòng cụ thể để chống phe nhóm).
  Đủ 15 người thì đếm ngược 10 giây rồi vào trận. Vòng bo thu hẹp sau 45 giây; người sống sót cuối cùng
  (hoặc con dài nhất khi hết 5 phút) nhận toàn bộ tiền cược trừ 5% phí nhà cái.

> ⚠️ Hiện đang ở **chế độ thử**: tiền là tiền ảo (nút "Nạp thử"), lệnh rút chỉ được ghi lại chứ chưa chuyển tiền thật.
> Chưa có đăng nhập bằng ví: tài khoản gắn với token lưu trong trình duyệt, xoá dữ liệu trình duyệt là mất tài khoản.

## Chạy trên máy
```
npm install
npm start
```
Mở http://localhost:3000. Cần Node.js 22.13 trở lên (dùng SQLite có sẵn trong Node).

Biến môi trường:
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3000 | cổng server |
| `PAID_MODE` | tắt | `1` để bật chế độ chơi mất phí + ví. Khi tắt, server gỡ hẳn các phần liên quan khỏi trang và từ chối mọi yêu cầu nạp/rút/vào phòng mất phí |
| `PAID_ROOM_SIZE` | 15 | số người mỗi phòng mất phí (đặt 2 để tự thử) |
| `DEMO` | 1 | `0` để tắt nút nạp tiền ảo |
| `DB_PATH` | `data.sqlite` | file cơ sở dữ liệu |
| `NODE_ENV` | – | `production` bật chặn 2 người cùng IP vào một phòng mất phí |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / 12345678 | tài khoản trang quản trị `/admin`. Để trống mật khẩu = dùng mặc định 12345678 (bị buộc đổi ở lần đăng nhập đầu) |
| `SITE_URL` | `http://localhost:PORT` | tên miền thật (vd. `https://tenmien.vn`) — dùng cho thẻ canonical, Open Graph, `robots.txt`, `sitemap.xml` |

## Ngôn ngữ & SEO/GEO
- 11 ngôn ngữ: English (mặc định, `/`), 中文 `/zh/`, हिन्दी `/hi/`, Español `/es/`, العربية `/ar/` (phải→trái), Français `/fr/`, বাংলা `/bn/`, Português `/pt/`, Русский `/ru/`, Bahasa Indonesia `/id/`, Tiếng Việt `/vi/`.
- Trang chủ được **dựng từ 1 khung chung** (`pages.js`) + **1 file bản dịch mỗi ngôn ngữ** (`locales/<mã>.js`: seo, nội dung trang, chữ trong game `ui`, thông báo server `server`). `locales/en.js` là bản gốc; bản dịch nào thiếu khoá sẽ dùng tạm tiếng Anh và in cảnh báo khi khởi động.
- Thêm ngôn ngữ: tạo `locales/<mã>.js` theo mẫu `en.js`, thêm mã vào `locales/index.js`, thêm locale số vào `public/i18n.js`.
- Từ khoá chính "Slither io" chỉ dùng để **mô tả thể loại**; mọi ngôn ngữ đều có dòng ghi rõ không liên kết với Slither.io/Lowtech Studios.
- GEO: đoạn định nghĩa, bảng thông tin nhanh, so sánh với Slither.io, FAQ (JSON-LD sinh cùng nguồn với FAQ hiển thị), HowTo, `/llms.txt`, `robots.txt` cho phép bot AI, `sitemap.xml` có hreflang cho cả 11 ngôn ngữ (`seo-files.js`). Đổi nội dung thì sửa `SITE_UPDATED` trong `pages.js`.
- Bản dịch do AI viết — nên nhờ người bản xứ đọc lại, nhất là tiêu đề/mô tả SEO.

## Trang quản trị (/admin)
Đăng nhập bằng **admin / 12345678**. Lần đầu sẽ bị buộc đổi mật khẩu; mật khẩu mới lưu dạng băm scrypt trong bảng `settings` (khoá `admin.pass`). Đổi mật khẩu sau này ở tab **Tài khoản**. Quên mật khẩu: xoá dòng `admin.pass` trong bảng `settings` → quay về 12345678. Trong trang quản trị:
- **Thống kê**: lượt truy cập, khách không trùng, lượt chơi, số người đang online, biểu đồ theo ngày (7/30/90 ngày), quốc gia, thiết bị, nguồn truy cập. Không lưu IP khách.
- **Cài đặt SEO**: tiêu đề, mô tả, từ khoá riêng cho từng ngôn ngữ trong 11 ngôn ngữ, mã xác minh Google Search Console — áp dụng ngay.
- Quốc gia lấy từ header của Cloudflare/Vercel/CloudFront; nếu không chạy sau CDN thì cài thêm `npm i geoip-lite` (~115MB).
- Bảo mật: sai mật khẩu 5 lần → khoá 15 phút; cookie HttpOnly + SameSite=Strict; phiên hết hạn sau 12 giờ.

## Cấu trúc
- `server.js` — sảnh, phòng miễn phí, hàng chờ + trận mất phí, trả thưởng, nạp/rút.
- `room.js` — mô phỏng một phòng: rắn, mồi, va chạm, bot, vòng bo. Gửi trạng thái 30 lần/giây.
- `panel.js` — trang quản trị: đăng nhập, API thống kê/cài đặt, ghi lượt truy cập, điền thẻ SEO. Giao diện ở thư mục `admin/`.
- `db.js` — sổ cái tiền (SQLite). Mọi thay đổi số dư đều ghi vào bảng `ledger`; tiền vé được "giữ" trong
  bảng `entries` và **tự hoàn lại khi server khởi động lại** nếu trận bị gián đoạn. Phí nhà cái cộng vào tài khoản id 0.
- `public/skins.js` — 6 mẫu rắn: Cổ điển (một màu, người chơi chọn màu) + Neon Cyber, Rồng Vàng, Kẹo Cầu Vồng, Trăn Rừng, Thiên Hà. Thứ tự phải khớp `SKIN_HUES` trong `room.js`.
- `public/index.html` — website: header, khung game, nội dung SEO (giới thiệu, cách chơi, chế độ, mẫu rắn, mẹo, hỏi đáp), footer. `site.js` lo phần website (menu điện thoại, bộ sưu tập mẫu rắn).
- `public/client.js` — game (Canvas) chạy trong khung `#gameWrap`.

## Việc còn lại trước khi dùng tiền thật
1. Pháp lý (xem ghi chú đã trao đổi) — bắt buộc trước tiên.
2. Đăng nhập bằng ví (ký tin nhắn MetaMask) thay cho token trình duyệt.
3. Nạp thật: cấp địa chỉ nạp riêng cho mỗi người, theo dõi blockchain để cộng tiền (BSC/Polygon, USDT + USDC).
4. Rút thật: bảng `withdrawals` → worker ký giao dịch từ ví nóng; lệnh lớn duyệt tay.
5. Chạy sau HTTPS, sao lưu `data.sqlite` định kỳ.
