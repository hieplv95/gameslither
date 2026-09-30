#!/usr/bin/env bash
# Cài GameSlither lên VPS Ubuntu 22.04 / 24.04 (chạy bằng root). An toàn cho VPS đang chạy dự án khác:
#  - Node.js 22 cài riêng vào /opt/node22 (không đụng Node hệ thống)
#  - không xoá cấu hình Nginx sẵn có, không bật tường lửa trừ khi yêu cầu
#  - kiểm tra cổng trước, cổng bận thì dừng
#
#   EMAIL=ban@email.com bash setup.sh
#
# Tuỳ chọn:
#   DOMAIN=gameslither.io      tên miền (mặc định gameslither.io)
#   PORT=3100                  cổng nội bộ của game (mặc định 3100)
#   USE_CLOUDFLARE=1           website chạy sau Cloudflare (lấy đúng IP khách)
#   SETUP_FIREWALL=1           bật ufw, chỉ mở SSH/HTTP/HTTPS (KHÔNG dùng nếu VPS có dịch vụ khác cần cổng khác)
#   REPO=https://...           địa chỉ repo (repo private: https://<token>@github.com/...)
#   SKIP_SSL=1                 bỏ qua bước cấp chứng chỉ SSL
set -euo pipefail
# Không hỏi gì khi cài gói, và KHÔNG tự khởi động lại dịch vụ (needrestart chỉ liệt kê):
# tránh rớt SSH và gián đoạn các dự án khác trên cùng VPS.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
export NEEDRESTART_SUSPEND=1

DOMAIN="${DOMAIN:-gameslither.io}"
EMAIL="${EMAIL:?Hãy đặt EMAIL=... (dùng để đăng ký chứng chỉ SSL)}"
PORT="${PORT:-3100}"
REPO="${REPO:-https://github.com/hieplv95/gameslither.git}"
USE_CLOUDFLARE="${USE_CLOUDFLARE:-0}"
APP_DIR=/opt/gameslither
APP_USER=gameslither
NODE_DIR=/opt/node22

[ "$(id -u)" -eq 0 ] || { echo "Hãy chạy bằng root (sudo -i)"; exit 1; }

echo "==> Kiểm tra cổng"
if ss -ltnp "( sport = :$PORT )" | grep -q LISTEN && ! systemctl is-active --quiet gameslither; then
  echo "LỖI: cổng $PORT đang bị chương trình khác dùng:"; ss -ltnp "( sport = :$PORT )"
  echo "Chạy lại với cổng khác, ví dụ: PORT=3200 EMAIL=$EMAIL bash setup.sh"; exit 1
fi
if ss -ltnp "( sport = :80 )" | grep LISTEN | grep -vq nginx; then
  echo "LỖI: cổng 80 đang do chương trình khác (không phải Nginx) giữ:"; ss -ltnp "( sport = :80 )"
  echo "Script này dùng Nginx. Hãy gửi kết quả trên để cấu hình theo proxy đang có."; exit 1
fi

echo "==> Cài gói hệ thống"
dpkg --configure -a || true   # hoàn tất nếu lần cài trước bị ngắt giữa chừng
apt-get update -y
apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx sqlite3 xz-utils

echo "==> Node.js 22 riêng cho GameSlither ($NODE_DIR)"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Kiến trúc không hỗ trợ: $(uname -m)"; exit 1 ;; esac
  TARBALL=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk "/linux-$ARCH.tar.xz/ {print \$2}")
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$TARBALL" -o /tmp/node22.tar.xz
  mkdir -p "$NODE_DIR"
  tar -xJf /tmp/node22.tar.xz -C "$NODE_DIR" --strip-components=1
  rm -f /tmp/node22.tar.xz
fi
export PATH="$NODE_DIR/bin:$PATH"
node -v

echo "==> Lấy code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
git config --global --add safe.directory "$APP_DIR"   # thư mục thuộc user gameslither, root vẫn được pull
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

if [ ! -f .env ]; then
  cat > .env <<EOF
SITE_URL=https://$DOMAIN
ADMIN_USER=admin
EOF
fi
chmod 600 .env
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Dịch vụ systemd (cổng $PORT)"
sed -e "s#__PORT__#$PORT#g" -e "s#__NODE__#$NODE_DIR/bin/node#g" deploy/gameslither.service > /etc/systemd/system/gameslither.service
systemctl daemon-reload
systemctl enable gameslither
systemctl restart gameslither

echo "==> Nginx (thêm cấu hình riêng cho $DOMAIN, không đụng site khác)"
sed -e "s/gameslither\.io/$DOMAIN/g" -e "s#127.0.0.1:3000#127.0.0.1:$PORT#g" deploy/nginx-gameslither.conf > /etc/nginx/sites-available/gameslither
ln -sf /etc/nginx/sites-available/gameslither /etc/nginx/sites-enabled/gameslither
if [ "$USE_CLOUDFLARE" = "1" ]; then
  echo "==> Dải IP Cloudflare (để nhận đúng IP khách)"
  {
    echo "# Tự sinh bởi GameSlither setup.sh — IP thật của khách khi đi qua Cloudflare"
    for ip in $(curl -fsSL https://www.cloudflare.com/ips-v4) $(curl -fsSL https://www.cloudflare.com/ips-v6); do
      echo "set_real_ip_from $ip;"
    done
    echo "real_ip_header CF-Connecting-IP;"
  } > /etc/nginx/conf.d/cloudflare-realip.conf
fi
nginx -t
systemctl reload nginx

if [ "${SETUP_FIREWALL:-0}" = "1" ]; then
  echo "==> Tường lửa: chỉ mở SSH, HTTP, HTTPS"
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw --force enable
elif ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "==> ufw đang bật: mở thêm HTTP/HTTPS"
  ufw allow 'Nginx Full'
fi

if [ "${SKIP_SSL:-0}" != "1" ]; then
  echo "==> Chứng chỉ SSL (Let's Encrypt)"
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
fi

echo "==> Sao lưu cơ sở dữ liệu mỗi ngày lúc 3h sáng (giữ 14 bản)"
mkdir -p /var/backups/gameslither
cat > /etc/cron.d/gameslither-backup <<EOF
0 3 * * * root sqlite3 $APP_DIR/data.sqlite ".backup /var/backups/gameslither/data-\$(date +\%F).sqlite" && find /var/backups/gameslither -name 'data-*.sqlite' -mtime +14 -delete
EOF

sleep 1
systemctl --no-pager --lines=3 status gameslither || true
echo
echo "XONG! Mở https://$DOMAIN"
echo "Trang quản trị: https://$DOMAIN/admin  (admin / 12345678 — đổi mật khẩu ngay lần đầu đăng nhập)"
echo "Xem log: journalctl -u gameslither -f"
