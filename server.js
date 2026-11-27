const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const app = express();

// Phục vụ giao diện LiveStream Pickleball (index.html) & Trang Trọng Tài (referee.html)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Quản lý phòng đồng bộ điểm số Trọng tài <-> Camera Live
// rooms: Map<roomId, { state: object | null, clients: Set<WebSocket> }>
const rooms = new Map();

function getRoom(roomId) {
  const id = String(roomId || 'SAN-1').trim().toUpperCase();
  if (!rooms.has(id)) {
    rooms.set(id, { state: null, clients: new Set() });
  }
  return { id, room: rooms.get(id) };
}

function buildRtmpDestination(url, key) {
  const cleanUrl = url.endsWith('/') ? url : `${url}/`;
  return `${cleanUrl}${key}`;
}

wss.on('connection', (ws) => {
  let ffmpeg = null;
  let joinedRoomId = null;

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

  const leaveRoom = () => {
    if (joinedRoomId && rooms.has(joinedRoomId)) {
      const r = rooms.get(joinedRoomId);
      r.clients.delete(ws);
      if (r.clients.size === 0 && !r.state) {
        rooms.delete(joinedRoomId);
      }
    }
    joinedRoomId = null;
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());

        // --- Đồng bộ điểm số Trọng tài ---
        if (msg.type === 'join_room') {
          leaveRoom();
          const { id, room } = getRoom(msg.roomId);
          joinedRoomId = id;
          room.clients.add(ws);
          if (room.state && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'score_sync', roomId: id, state: room.state }));
          }
          return;
        }

        if (msg.type === 'score_update') {
          const { id, room } = getRoom(msg.roomId || joinedRoomId);
          room.state = msg.state;
          for (const client of room.clients) {
            if (client !== ws && client.readyState === ws.OPEN) {
              client.send(JSON.stringify({ type: 'score_sync', roomId: id, state: msg.state }));
            }
          }
          return;
        }

        // --- Điều khiển luồng FFmpeg RTMP ---
        if (msg.type === 'start') {
          stopFfmpeg();
          const { youtube, facebook, fps = 30, bitrate = 2200000, isH264 = false, isAac = false } = msg.config || {};
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

          const gop = fps * 2;
          const videoBitrateK = `${Math.round(bitrate / 1000)}k`;
          const maxrateK = `${Math.round((bitrate * 1.15) / 1000)}k`;
          const bufsizeK = `${Math.round((bitrate * 2) / 1000)}k`;

          const videoArgs = isH264
            ? ['-c:v', 'copy']
            : [
                '-vf', 'scale=-2:480',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p',
                '-vsync', '1',
                '-r', String(fps),
                '-g', String(gop),
                '-keyint_min', String(gop),
                '-sc_threshold', '0',
                '-b:v', videoBitrateK,
                '-maxrate', maxrateK,
                '-bufsize', bufsizeK,
                '-threads', '0'
              ];

          const audioArgs = isAac
            ? ['-c:a', 'copy']
            : [
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0'
              ];

          const args = [
            '-fflags', '+genpts+nobuffer+discardcorrupt',
            '-flags', 'low_delay',
            '-analyzeduration', '100000',
            '-probesize', '100000',
            '-i', 'pipe:0',
            ...videoArgs,
            ...audioArgs,
            '-flush_packets', '1',
            '-muxdelay', '0',
            '-muxpreload', '0',
            '-flvflags', 'no_duration_filesize',
            '-max_muxing_queue_size', '256',
            '-flags', '+global_header',
            '-f', 'tee',
            '-map', '0:v',
            '-map', '0:a?',
            outputs.join('|')
          ];

          sendLog(`Đang phát tới ${outputs.length} nền tảng (${isH264 ? 'Chế độ H.264 siêu nhẹ - 0% CPU video' : 'Chế độ nén nhanh 480p'})...`, 'success');
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

    // Dữ liệu video/audio nhị phân từ trình duyệt điện thoại (chống dồn hàng đợi gây trễ 1 phút)
    if (ffmpeg && ffmpeg.stdin.writable) {
      if (ffmpeg.stdin.writableLength > 512 * 1024) {
        return;
      }
      ffmpeg.stdin.write(data);
    }
  });

  ws.on('close', () => {
    stopFfmpeg();
    leaveRoom();
  });

  ws.on('error', () => {
    stopFfmpeg();
    leaveRoom();
  });
});

server.listen(PORT, () => {
  console.log(`Pickleball Live Studio Relay đang chạy tại cổng ${PORT}`);
});
