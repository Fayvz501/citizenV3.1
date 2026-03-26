require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initDb } = require('./database');
const { socketAuth } = require('./auth');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 300 }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
app.use('/api', routes);

const online = new Map();
io.use(socketAuth);
io.on('connection', (s) => {
  online.set(s.user.id, s.id); io.emit('online_count', online.size);
  s.on('new_incident', d => s.broadcast.emit('incident_added', d));
  s.on('vote_update', d => s.broadcast.emit('vote_changed', d));
  s.on('new_comment', d => s.broadcast.emit('comment_added', d));
  s.on('chat_message', d => io.emit('chat_msg', { ...d, username: s.user.username, user_id: s.user.id, created_at: new Date().toISOString() }));
  s.on('streamer_claim', d => io.emit('streamer_update', { ...d, username: s.user.username }));
  s.on('sos_alert', d => io.emit('sos_broadcast', { ...d, username: s.user.username }));
  s.on('patrol_update', d => s.broadcast.emit('patrol_moved', { user_id: s.user.id, username: s.user.username, ...d }));
  s.on('patrol_start', () => io.emit('patrol_started', { user_id: s.user.id }));
  s.on('patrol_stop', () => io.emit('patrol_stopped', { user_id: s.user.id }));
  s.on('emergency_alert', d => io.emit('emergency_broadcast', d));
  s.on('incident_resolved', d => io.emit('incident_status_changed', d));
  s.on('disconnect', () => { online.delete(s.user.id); io.emit('online_count', online.size); io.emit('patrol_stopped', { user_id: s.user.id }); });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

(async () => {
  await initDb();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`\n  ⚡ Citizen Monitor v3 — http://localhost:${PORT}\n`));
})();
