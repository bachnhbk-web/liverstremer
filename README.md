# LiveStream Pro — Bộ Máy Chủ Relay (YouTube + Facebook)

Trình duyệt di động không thể mở kết nối TCP/RTMP trực tiếp. Máy chủ nhỏ gọn này nhận luồng video + âm thanh từ điện thoại qua `wss://` và dùng **FFmpeg (`tee` muxer)** đẩy đồng thời lên:
- **YouTube Live**: `rtmp://a.rtmp.youtube.com/live2/<stream-key>`
- **Facebook Live**: `rtmps://live-api-s.facebook.com:443/rtmp/<stream-key>`

Cấu hình FFmpeg đã tối ưu sẵn `pix_fmt yuv420p`, `gop = 2 giây`, `aac 44.1kHz`, và `onfail=ignore` (nếu một nền tảng rớt mạng, nền tảng còn lại vẫn phát tiếp bình thường).

## Cách triển khai nhanh (Render / Railway / Fly.io)
1. Đưa thư mục này lên một kho GitHub.
2. Tạo Web Service mới chọn môi trường **Docker** (dùng sẵn `Dockerfile`).
3. Sau khi triển khai, mở địa chỉ `https://ten-mien-cua-ban` ngay trên điện thoại (giao diện `public/index.html` đã được đóng gói sẵn) và dán `wss://ten-mien-cua-ban` vào ô **Máy chủ Relay**.

## Cách chạy trên VPS có Docker
```bash
docker build -t live-relay .
docker run -d --name live-relay -p 8080:8080 --restart unless-stopped live-relay
```
(Khuyên dùng Nginx / Caddy bật chứng chỉ SSL HTTPS/WSS để trình duyệt điện thoại cấp quyền truy cập Camera.)
