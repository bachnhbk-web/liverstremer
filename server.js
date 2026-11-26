const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const app = express();

// Phục vụ trực tiếp giao diện LiveStream Pro khi mở trên điện thoại
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function buildRtmpDestination(url, key) {
  const cleanUrl = url.endsWith('/') ? url : `${url}/`;
  return `${cleanUrl}${key}`;
}

wss.on('connection', (ws) => {
  let ffmpeg = null;

  const sendLog = (log, level = 'info') => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ log, level }));
    }
  };

  const stopFfmpeg = () => {
    if (ffmpeg) {
      try {
        ffmpeg.stdin.end();
        ffmpeg.kill('SIGINT');
      } catch (e) {}
      ffmpeg = null;
    }
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'start') {
          stopFfmpeg();
          const { youtube, facebook, fps = 30, bitrate = 2500000 } = msg.config || {};
          const outputs = [];

          if (youtube && youtube.url && youtube.key) {
            outputs.push(`[f=flv:onfail=ignore]${buildRtmpDestination(youtube.url, youtube.key)}`);
          }
          if (facebook && facebook.url && facebook.key) {
            outputs.push(`[f=flv:onfail=ignore]${buildRtmpDestination(facebook.url, facebook.key)}`);
          }

          if (outputs.length === 0) {
            sendLog('Chưa có đích phát YouTube hoặc Facebook hợp lệ.', 'error');
            return;
          }

          const gop = fps * 2; // Keyframe mỗi 2 giây — bắt buộc cho YouTube & Facebook Live Producer
          const videoBitrateK = `${Math.round(bitrate / 1000)}k`;
          const maxrateK = `${Math.round((bitrate * 1.15) / 1000)}k`;
          const bufsizeK = `${Math.round((bitrate * 2) / 1000)}k`;

          const args = [
            '-i', 'pipe:0',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-r', String(fps),
            '-g', String(gop),
            '-keyint_min', String(gop),
            '-sc_threshold', '0',
            '-b:v', videoBitrateK,
            '-maxrate', maxrateK,
            '-bufsize', bufsizeK,
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            '-flags', '+global_header',
            '-f', 'tee',
            '-map', '0:v',
            '-map', '0:a?',
            outputs.join('|')
          ];

          sendLog(`Đang khởi chạy FFmpeg phát đồng thời tới ${outputs.length} nền tảng...`, 'success');
          ffmpeg = spawn('ffmpeg', args);

          ffmpeg.stderr.on('data', (chunk) => {
            const line = chunk.toString().trim();
            if (line.includes('Error') || line.includes('failed') || line.includes('rtmp')) {
              sendLog(line.slice(0, 180), 'warn');
            }
          });

          ffmpeg.on('close', (code) => {
            sendLog(`FFmpeg đã dừng (mã thoát: ${code}).`, 'info');
            ffmpeg = null;
          });
        } else if (msg.type === 'stop') {
          stopFfmpeg();
          sendLog('Đã dừng luồng phát trên máy chủ.', 'info');
        }
      } catch (err) {
        sendLog(`Lỗi cấu hình: ${err.message}`, 'error');
      }
      return;
    }

    // Dữ liệu video/audio nhị phân từ trình duyệt điện thoại
    if (ffmpeg && ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(data);
    }
  });

  ws.on('close', stopFfmpeg);
  ws.on('error', stopFfmpeg);
});

server.listen(PORT, () => {
  console.log(`LiveStream Pro Relay đang chạy tại cổng ${PORT}`);
});
