# GameSlither — game rắn online kiểu slither.io

Hai chế độ:
- **Chơi miễn phí**: vào nhanh phòng công khai, chọn phòng trong danh sách, hoặc tạo phòng riêng và mời bạn bè bằng mã 4 ký tự. Có bot.
- **Chơi mất phí**: chọn mức cược 1 / 5 / 10 USDT; hệ thống tự xếp phòng (không cho chọn phòng cụ thể để chống phe nhóm).
  Đủ 15 người thì đếm ngược 10 giây rồi vào trận. Vòng bo thu hẹp sau 45 giây; người sống sót cuối cùng
  (hoặc con dài nhất khi hết 5 phút) nhận toàn bộ tiền cược trừ 5% phí nhà cái.

**Cửa hàng skin**: chơi miễn phí để kiếm **xu** 🪙 (tách riêng, không đổi được ra USDT). Khi rắn chết: +1 xu cho mỗi 10 độ dài
đạt được (tính từ độ dài lúc mới vào) và +5 xu cho mỗi con rắn đã hạ gục. Dùng xu mua 23 skin cờ: 20 nước đông dân nhất
(Liên Hợp Quốc, ước tính 2025) + Vương quốc Anh, Ý, Tây Ban Nha, giá 500 xu/skin. Đổi các mức này ở đầu `server.js` (`COINS_PER_LENGTH`, `KILL_COINS`, `SKIN_PRICE`).
Server kiểm tra quyền sở hữu: gửi số skin chưa mua sẽ bị đổi về skin Cổ điển. Mẫu vẽ cờ ở `public/skins.js`.

**Giữ chân người chơi** (chỉnh các mức ở đầu `server.js`):
- **Nhiệm vụ hằng ngày** (`MISSION_POOL`): mỗi ngày 3 nhiệm vụ giống nhau cho mọi người — luôn có "chơi N ván" + 2 trong 3 nhóm
  hạ rắn / đạt độ dài / sống sót. Đổi lúc 0 giờ giờ Việt Nam. Xong là cộng xu ngay (kể cả khi đang chơi).
- **Quà đăng nhập liên tiếp** (`STREAK_REWARDS`): 20 → 200 xu cho ngày 1 → 7 rồi lặp lại; bỏ 1 ngày là về ngày 1.
- **Skin thành tích** (`ACHIEVEMENTS`, số 29–32): Hoả Ngục (độ dài 1.500 trong 1 mạng), Băng Giá (sống 10 phút), Bóng Đêm
  (hạ 5 rắn trong 1 mạng), Cực Quang (đăng nhập 7 ngày liên tiếp). Không bán, tự mở khoá.
- **Bảng vàng** tuần (bắt đầu thứ Hai) và mọi thời đại: ván dài nhất của mỗi tài khoản, chỉ tính phòng miễn phí, ván từ độ dài 50.
- **Mã khôi phục tài khoản** (nút Tài khoản ở sảnh): mã 16 ký tự, lưu dạng băm. Nhập mã trên máy khác → máy đó dùng chung tài khoản
  (máy cũ vẫn đăng nhập bình thường). Tạo mã mới thì mã cũ hết hiệu lực.

**Trong trận**: âm thanh tự tổng hợp (WebAudio, có nút tắt), rung trên điện thoại, dòng thông báo hạ gục, hiệu ứng nổ khi rắn chết,
màn hình kết quả có thống kê + nút **Chia sẻ** (tạo ảnh 1200×630; điện thoại mở bảng chia sẻ, máy tính tải ảnh và chép sẵn lời mời),
nút **Mời bạn** chép link `/?room=MÃ` — người nhận bấm "Chơi ngay" là vào đúng phòng.
Bot có 3 tính cách: nhút nhát (né rắn to), thợ săn (chặn đầu rắn nhỏ hơn, từ độ dài 40), tham ăn (lao vào ăn xác).

**Giao thức mạng**: gói trạng thái 30 lần/giây gửi dạng nhị phân (cấu trúc ghi ở `room.js`, giải mã ở `decodeState()` trong
`public/client.js`) — nhỏ hơn JSON khoảng 3,5 lần (~14 KB/s mỗi người chơi thay vì ~48 KB/s). Các tin khác vẫn là JSON.

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
| `FOOD_MULT` | 2 | hệ số lượng mồi (1 = 2.200 viên mỗi phòng miễn phí, 2 = 4.400; tối đa 5) |
| `FREE_BOTS` | 40 | số rắn mỗi phòng miễn phí luôn giữ, tính cả người và bot (người vào thì bot rút bớt, luôn còn ít nhất 6 bot; tối đa 80) |
| `PAID_ROOM_SIZE` | 15 | số người mỗi phòng mất phí (đặt 2 để tự thử) |
| `DEMO` | 1 | `0` để tắt nút nạp tiền ảo |
| `DB_PATH` | `data.sqlite` | file cơ sở dữ liệu |
| `NODE_ENV` | – | `production` bật chặn 2 người cùng IP vào một phòng mất phí |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / 12345678 | tài khoản trang quản trị `/admin`. Để trống mật khẩu = dùng mặc định 12345678 (bị buộc đổi ở lần đăng nhập đầu) |
| `SITE_URL` | `http://localhost:PORT` | tên miền thật (vd. `https://tenmien.vn`) — dùng cho thẻ canonical, Open Graph, `robots.txt`, `sitemap.xml` |

## Chạy trên VPS (Ubuntu 22.04/24.04)
1. DNS: tạo bản ghi **A** `@` và `www` trỏ về IP của VPS (Namecheap → Advanced DNS, hoặc Cloudflare).
2. SSH vào VPS bằng root rồi chạy:
   ```
   curl -fsSL https://raw.githubusercontent.com/hieplv95/gameslither/main/deploy/setup.sh -o setup.sh
   EMAIL=ban@email.com bash setup.sh            # thêm USE_CLOUDFLARE=1 nếu dùng Cloudflare
   ```
   Script cài Node 22 riêng (/opt/node22, không đụng Node hệ thống), cấu hình Nginx riêng cho domain (có WebSocket, không đụng site khác), SSL Let's Encrypt, dịch vụ systemd (cổng nội bộ 3100, đổi bằng PORT=...), sao lưu DB mỗi ngày. Tường lửa chỉ bật khi thêm SETUP_FIREWALL=1. Script dừng lại nếu cổng đã bị chương trình khác dùng.
3. Mở https://gameslither.io/admin → đăng nhập admin / 12345678 → đổi mật khẩu.
4. Cập nhật code sau này: `bash /opt/gameslither/deploy/update.sh`.

File cấu hình: `deploy/nginx-gameslither.conf`, `deploy/gameslither.service`. Log: `journalctl -u gameslither -f`.

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
- **Blog**: công cụ viết bài tự động + quản lý bài (xem mục Blog bên dưới).
- Quốc gia lấy từ header của Cloudflare/Vercel/CloudFront; nếu không chạy sau CDN thì cài thêm `npm i geoip-lite` (~115MB).
- Bảo mật: sai mật khẩu 5 lần → khoá 15 phút; cookie HttpOnly + SameSite=Strict; phiên hết hạn sau 12 giờ.

## Blog (/blog/, /vi/blog/, …)
- Mỗi bài thuộc **1 ngôn ngữ**: bài tiếng Việt ở `/vi/blog/<slug>`, tiếng Anh ở `/blog/<slug>`… Trang danh sách `/<ngôn ngữ>/blog/`, RSS `/<ngôn ngữ>/blog/rss.xml`.
- Menu "Blog" và khối "Bài viết khác" trên trang chủ **chỉ hiện ở ngôn ngữ đã có bài**. Trang blog của ngôn ngữ chưa có bài mang `noindex` và không vào sitemap (tránh nội dung mỏng).
- SEO mỗi bài: title/description riêng, canonical, Open Graph + Twitter card (ảnh bìa), JSON-LD `BlogPosting` + `BreadcrumbList` + `FAQPage`, mục lục, thời gian đọc, liên kết nội bộ về game và các bài khác, sitemap có ảnh (`image:image`), `llms.txt` liệt kê bài.
- **Trang quản trị → tab Blog**:
  1. Chọn ngôn ngữ (mặc định English → bài ở `/blog/<slug>`), (tuỳ chọn) nhập hướng chủ đề → **💡 Gợi ý chủ đề**: AI đề xuất ~10 chủ đề kèm từ khoá chính, loại tìm kiếm, góc viết (tránh trùng bài đã có).
  2. Bấm 1 gợi ý hoặc tự nhập chủ đề/từ khoá, chọn độ dài, giọng văn, số ảnh, yêu cầu thêm → **✍️ Viết bài**. Mất khoảng 1–3 phút, chạy nền (có thể viết tối đa 3 bài cùng lúc).
  3. Bài lưu dạng **bản nháp** (hoặc đăng ngay nếu tick ô). Mở bài để đọc lại, sửa Markdown, đổi slug/mô tả/ảnh bìa/FAQ, **Xem trước**, rồi đổi trạng thái sang **Đã đăng**.
- Chữ do Claude viết (`ANTHROPIC_API_KEY`, model `BLOG_MODEL`, mặc định `claude-opus-5`). Chỉ dùng đúng key này — tính phí theo token vào tài khoản API (console.anthropic.com), không dùng gói Claude Pro/Max. Yêu cầu gửi kèm `fallbacks: "default"`: nếu model chính từ chối, API tự chạy lại bằng model dự phòng.
- Ảnh: có `VERTEX_KEY_FILE` → Gemini vẽ ảnh qua Vertex AI (Google Cloud); có `OPENAI_API_KEY` → AI vẽ ảnh minh hoạ; có `PEXELS_API_KEY` → ảnh kho Pexels (tự ghi nguồn); không có → chỉ tạo ảnh bìa SVG tự vẽ (Facebook/Zalo không hiển thị SVG khi chia sẻ — nên dùng 1 trong các key trên hoặc tự tải ảnh bìa lên).
- Ảnh do AI vẽ (Vertex/OpenAI) được **đóng logo GameSlither** ở góc dưới phải và lưu dạng WebP. Logo ở `assets/logo-badge.svg`; sửa xong chạy `node assets/make-logo.js` (trên máy có font) để dựng lại `logo-badge.png`. Tắt bằng `BLOG_IMAGE_LOGO=0`.
- **Kết nối Vertex AI** (dùng được credit dùng thử Google Cloud; Gemini API key của AI Studio thì không):
  1. Google Cloud Console → chọn project → bật **Vertex AI API** (`aiplatform.googleapis.com`).
  2. IAM & Admin → Service Accounts → tạo tài khoản (vd. `gameslither-images`), cấp vai trò **Vertex AI User**.
  3. Mở tài khoản đó → Keys → Add key → Create new key → **JSON** → tải file về.
  4. Đưa file lên VPS: `/opt/gameslither/vertex-key.json`, rồi `sudo chown gameslither /opt/gameslither/vertex-key.json && sudo chmod 600 /opt/gameslither/vertex-key.json`.
  5. Thêm vào `.env`: `VERTEX_KEY_FILE=/opt/gameslither/vertex-key.json` → `sudo systemctl restart gameslither`.
  6. Thử ở trang quản trị → Blog → mở 1 bài → nút tạo ảnh AI; lỗi (sai quyền, sai tên model…) hiện ngay trên màn hình.
  Model mặc định `gemini-3.1-flash-image`; đổi bằng `VERTEX_IMAGE_MODEL` (rẻ hơn: `gemini-3.1-flash-lite-image`, đẹp hơn: `gemini-3-pro-image`).
- Ảnh lưu trong thư mục `media/` (không đưa lên git). Trên VPS được sao lưu mỗi Chủ nhật vào `/var/backups/gameslither/media-*.tgz`.
- Nên đọc lại bài trước khi đăng: AI có thể viết sai chi tiết. Không nên đăng hàng loạt bài tự động không qua kiểm duyệt — Google đánh giá thấp nội dung hàng loạt kém chất lượng.

## Cấu trúc
- `server.js` — sảnh, phòng miễn phí, hàng chờ + trận mất phí, trả thưởng, nạp/rút.
- `room.js` — mô phỏng một phòng: rắn, mồi, va chạm, bot, vòng bo. Gửi trạng thái 30 lần/giây.
- `panel.js` — trang quản trị: đăng nhập, API thống kê/cài đặt/blog, ghi lượt truy cập, điền thẻ SEO. Giao diện ở thư mục `admin/`.
- `blog.js` — trang blog (danh sách, bài viết, RSS), chuyển Markdown → HTML an toàn, ảnh `/media/`, phần blog trong sitemap.
- `writer.js` — công cụ viết bài: gợi ý chủ đề + viết bài bằng Claude API, tạo ảnh (OpenAI / Pexels / SVG), chạy nền.
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
