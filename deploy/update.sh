#!/usr/bin/env bash
# Cập nhật GameSlither trên VPS sau khi đẩy code mới lên GitHub (chạy bằng root):
#   bash /opt/gameslither/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/gameslither
export PATH="/opt/node22/bin:$PATH"
cd "$APP_DIR"
mkdir -p /var/backups/gameslither
sqlite3 data.sqlite ".backup /var/backups/gameslither/data-before-update-$(date +%F-%H%M).sqlite" 2>/dev/null || true
sudo -u gameslither env PATH="$PATH" git pull --ff-only
sudo -u gameslither env PATH="$PATH" npm ci --omit=dev
# giữ nguyên cổng đang dùng khi cập nhật file dịch vụ
PORT=$(grep -oP 'PORT=\K[0-9]+' /etc/systemd/system/gameslither.service || echo 3100)
sed -e "s#__PORT__#$PORT#g" -e "s#__NODE__#/opt/node22/bin/node#g" deploy/gameslither.service > /etc/systemd/system/gameslither.service
systemctl daemon-reload
systemctl restart gameslither
sleep 1
systemctl --no-pager --lines=5 status gameslither
