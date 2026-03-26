const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./database');
const { generateToken, authMiddleware, optionalAuth, modOnly, getVoteWeight, exchangeVkCode } = require('./auth');
const { checkAndAward, getUserAchievements } = require('./achievements');
const { moderateText } = require('./moderation');

const router = express.Router();
const VK_BOT_WEBHOOK = process.env.VK_BOT_WEBHOOK || '';

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'public', 'uploads'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10*1024*1024 }, fileFilter: (req, file, cb) => {
  cb(null, /jpeg|jpg|png|gif|webp|mp4|webm/.test(path.extname(file.originalname).toLowerCase()));
}});

// ─── VK Bot Notify Helper ───
async function notifyVk(route, data) {
  if (!VK_BOT_WEBHOOK) return;
  try { await fetch(`${VK_BOT_WEBHOOK}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); } catch {}
}

function haversine(lat1,lon1,lat2,lon2){const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180,a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function notifyNearbyDb(db,inc){const zones=db.prepare('SELECT * FROM user_zones').all();for(const z of zones){if(z.user_id===inc.user_id)continue;if(haversine(z.lat,z.lng,inc.lat,inc.lng)<=z.radius_km)db.prepare("INSERT INTO notifications (user_id,incident_id,type,message,message_en) VALUES (?,?,?,?,?)").run(z.user_id,inc.id,'zone_alert',`Событие в "${z.label}"`,`Incident in "${z.label}"`);}}

// ════════════════════════════════════
//  AUTH
// ════════════════════════════════════

router.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password, lang } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Все поля обязательны' });
    if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Имя: 3-20 символов' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль: мин. 6 символов' });
    const db = getDb();
    if (db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email)) return res.status(409).json({ error: 'Уже существует' });
    const hash = await bcrypt.hash(password, 10);
    const colors = ['#ff3b3b','#ff8c00','#ffd000','#3b8bff','#00d97e','#a855f7','#f472b6','#06b6d4'];
    const r = db.prepare('INSERT INTO users (username,email,password_hash,avatar_color,lang) VALUES (?,?,?,?,?)').run(username, email, hash, colors[Math.floor(Math.random()*colors.length)], lang||'ru');
    const user = db.prepare('SELECT id,username,email,avatar_color,reputation,is_streamer,trust_level,lang,vk_id,vk_photo FROM users WHERE id=?').get(r.lastInsertRowid);
    res.json({ token: generateToken(user), user });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(login, login);
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Неверный логин или пароль' });
    db.prepare('UPDATE users SET last_active=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
    res.json({ token: generateToken(user), user: { id:user.id,username:user.username,email:user.email,avatar_color:user.avatar_color,reputation:user.reputation,is_streamer:user.is_streamer,trust_level:user.trust_level,lang:user.lang,vk_id:user.vk_id,vk_photo:user.vk_photo } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ─── VK OAuth ───
router.post('/auth/vk', async (req, res) => {
  try {
    const { code, redirect_uri } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });

    const vk = await exchangeVkCode(code, redirect_uri);
    const db = getDb();

    // Check if VK user exists
    let user = db.prepare('SELECT * FROM users WHERE vk_id=?').get(vk.vk_id);

    if (user) {
      // Update VK info
      db.prepare('UPDATE users SET vk_name=?, vk_photo=?, last_active=CURRENT_TIMESTAMP WHERE id=?')
        .run(`${vk.first_name} ${vk.last_name}`, vk.photo, user.id);
    } else {
      // Create new user via VK
      const username = `${vk.first_name}_${vk.vk_id}`.substring(0, 20);
      const colors = ['#ff3b3b','#ff8c00','#ffd000','#3b8bff','#00d97e','#a855f7'];
      const r = db.prepare('INSERT INTO users (username,email,vk_id,vk_name,vk_photo,avatar_color) VALUES (?,?,?,?,?,?)')
        .run(username, vk.email, vk.vk_id, `${vk.first_name} ${vk.last_name}`, vk.photo, colors[Math.floor(Math.random()*colors.length)]);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    }

    const token = generateToken(user);
    res.json({ token, user: { id:user.id,username:user.username,email:user.email,avatar_color:user.avatar_color,reputation:user.reputation,is_streamer:user.is_streamer,trust_level:user.trust_level,lang:user.lang,vk_id:user.vk_id,vk_name:user.vk_name,vk_photo:user.vk_photo } });
  } catch (e) { console.error('VK auth error:', e.message); res.status(400).json({ error: e.message }); }
});

// ─── VK Link (for existing accounts) ───
router.post('/auth/vk/link', authMiddleware, async (req, res) => {
  try {
    const { code, redirect_uri } = req.body;
    const vk = await exchangeVkCode(code, redirect_uri);
    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE vk_id=?').get(vk.vk_id);
    if (existing && existing.id !== req.user.id) return res.status(409).json({ error: 'VK уже привязан к другому аккаунту' });
    db.prepare('UPDATE users SET vk_id=?,vk_name=?,vk_photo=? WHERE id=?').run(vk.vk_id, `${vk.first_name} ${vk.last_name}`, vk.photo, req.user.id);
    res.json({ success: true, vk_name: `${vk.first_name} ${vk.last_name}`, vk_photo: vk.photo });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/auth/me', authMiddleware, (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT id,username,email,avatar_color,reputation,is_streamer,trust_level,is_patrolling,lang,vk_id,vk_name,vk_photo,created_at FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ user: u, achievements: getUserAchievements(req.user.id) });
});

router.patch('/auth/streamer', authMiddleware, (req, res) => {
  const db = getDb(); const u = db.prepare('SELECT is_streamer FROM users WHERE id=?').get(req.user.id);
  const v = u.is_streamer ? 0 : 1; db.prepare('UPDATE users SET is_streamer=? WHERE id=?').run(v, req.user.id);
  res.json({ is_streamer: v });
});

router.patch('/auth/lang', authMiddleware, (req, res) => {
  const { lang } = req.body; if (!['ru','en'].includes(lang)) return res.status(400).json({ error: 'ru or en' });
  getDb().prepare('UPDATE users SET lang=? WHERE id=?').run(lang, req.user.id); res.json({ lang });
});

// ════════════════════════════════════
//  INCIDENTS
// ════════════════════════════════════

router.get('/incidents', optionalAuth, (req, res) => {
  const db = getDb(); const hours = parseInt(req.query.hours) || 24; const type = req.query.type;
  let sql = `SELECT i.*, u.username, u.avatar_color, u.reputation, u.trust_level, u.vk_photo,
    (SELECT COUNT(*) FROM votes WHERE incident_id=i.id AND vote_type='confirm') as confirms,
    (SELECT COUNT(*) FROM votes WHERE incident_id=i.id AND vote_type='fake') as fakes,
    (SELECT COUNT(*) FROM comments WHERE incident_id=i.id) as comment_count,
    (SELECT COUNT(*) FROM chat_messages WHERE incident_id=i.id) as chat_count,
    (SELECT COUNT(*) FROM streamer_claims WHERE incident_id=i.id AND status!='finished') as active_streamers,
    (SELECT GROUP_CONCAT(filename) FROM incident_media WHERE incident_id=i.id) as media_files
    FROM incidents i JOIN users u ON i.user_id=u.id WHERE i.created_at > datetime('now','-${hours} hours') AND i.status!='fake'`;
  if (type && type !== 'all') sql += ` AND i.type='${type}'`;
  sql += ' ORDER BY i.is_emergency DESC, i.created_at DESC';
  res.json({ incidents: db.prepare(sql).all() });
});

router.post('/incidents', authMiddleware, upload.array('media', 5), async (req, res) => {
  try {
    const { type, description, address, lat, lng } = req.body;
    if (!type || !description || lat == null || lng == null) return res.status(400).json({ error: 'Заполните поля' });
    const mod = moderateText(description); if (!mod.passed) return res.status(400).json({ error: 'Не прошло модерацию' });
    const db = getDb(); const uid = 'inc_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const isSos = type === 'sos' ? 1 : 0;
    db.prepare('INSERT INTO incidents (uid,user_id,type,description,address,lat,lng,is_emergency,moderation_score) VALUES (?,?,?,?,?,?,?,?,?)').run(uid,req.user.id,type,description,address||null,parseFloat(lat),parseFloat(lng),isSos,mod.score);
    const incident = db.prepare(`SELECT i.*,u.username,u.avatar_color,u.reputation,u.trust_level,u.vk_photo,0 as confirms,0 as fakes,0 as comment_count,0 as chat_count,0 as active_streamers,NULL as media_files FROM incidents i JOIN users u ON i.user_id=u.id WHERE i.uid=?`).get(uid);
    if (req.files?.length) { for (const f of req.files) db.prepare('INSERT INTO incident_media (incident_id,user_id,filename,original_name,mime_type) VALUES (?,?,?,?,?)').run(incident.id,req.user.id,f.filename,f.originalname,f.mimetype); incident.media_files = req.files.map(f=>f.filename).join(','); }
    db.prepare('INSERT INTO incident_timeline (incident_id,user_id,event_type,description) VALUES (?,?,?,?)').run(incident.id,req.user.id,'created','Событие создано');
    db.prepare('UPDATE users SET reputation=reputation+1 WHERE id=?').run(req.user.id);
    const newAch = checkAndAward(req.user.id);
    notifyNearbyDb(db, incident);
    // VK Bot notification
    notifyVk('/notify/incident', { ...incident, username: req.user.username });
    if (isSos) notifyVk('/notify/sos', { ...incident, username: req.user.username });
    res.json({ incident, new_achievements: newAch });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

router.patch('/incidents/:uid/resolve', authMiddleware, (req, res) => {
  const db = getDb(); const inc = db.prepare('SELECT * FROM incidents WHERE uid=?').get(req.params.uid);
  if (!inc) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE incidents SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE uid=?").run(req.params.uid);
  db.prepare('INSERT INTO incident_timeline (incident_id,user_id,event_type,description) VALUES (?,?,?,?)').run(inc.id,req.user.id,'resolved','Закрыто');
  notifyVk('/notify/status', { incident: inc, status: 'resolved' });
  res.json({ success: true });
});

// ════════════════════════════════════
//  VOTES
// ════════════════════════════════════
router.post('/incidents/:uid/vote', authMiddleware, (req, res) => {
  try {
    const { vote_type } = req.body; if (!['confirm','fake'].includes(vote_type)) return res.status(400).json({ error: 'confirm or fake' });
    const db = getDb(); const inc = db.prepare('SELECT id,user_id,uid FROM incidents WHERE uid=?').get(req.params.uid);
    if (!inc) return res.status(404).json({ error: 'Not found' }); if (inc.user_id===req.user.id) return res.status(400).json({ error: 'Нельзя за своё' });
    const u = db.prepare('SELECT trust_level FROM users WHERE id=?').get(req.user.id); const w = getVoteWeight(u.trust_level);
    const ex = db.prepare('SELECT id,vote_type FROM votes WHERE incident_id=? AND user_id=?').get(inc.id,req.user.id);
    if (ex) { if (ex.vote_type===vote_type) db.prepare('DELETE FROM votes WHERE id=?').run(ex.id); else db.prepare('UPDATE votes SET vote_type=?,weight=? WHERE id=?').run(vote_type,w,ex.id); }
    else db.prepare('INSERT INTO votes (incident_id,user_id,vote_type,weight) VALUES (?,?,?,?)').run(inc.id,req.user.id,vote_type,w);
    const confirms=db.prepare("SELECT COALESCE(SUM(weight),0) as w FROM votes WHERE incident_id=? AND vote_type='confirm'").get(inc.id).w;
    const fakes=db.prepare("SELECT COALESCE(SUM(weight),0) as w FROM votes WHERE incident_id=? AND vote_type='fake'").get(inc.id).w;
    if (fakes>=8&&fakes>confirms*2){db.prepare("UPDATE incidents SET status='fake' WHERE id=?").run(inc.id);notifyVk('/notify/status',{incident:inc,status:'fake'});}
    else if(confirms>=5){db.prepare("UPDATE incidents SET status='confirmed' WHERE id=?").run(inc.id);db.prepare('UPDATE users SET reputation=reputation+2 WHERE id=?').run(inc.user_id);notifyVk('/notify/status',{incident:inc,status:'confirmed'});}
    checkAndAward(req.user.id); res.json({ confirms: Math.round(confirms), fakes: Math.round(fakes) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error' }); }
});

// ════════════════════════════════════
//  COMMENTS / CHAT / TIMELINE
// ════════════════════════════════════
router.get('/incidents/:uid/comments', (req, res) => { const db=getDb(); const inc=db.prepare('SELECT id FROM incidents WHERE uid=?').get(req.params.uid); if(!inc) return res.status(404).json({error:'Not found'}); res.json({comments:db.prepare('SELECT c.*,u.username,u.avatar_color,u.reputation,u.trust_level,u.vk_photo FROM comments c JOIN users u ON c.user_id=u.id WHERE c.incident_id=? ORDER BY c.created_at ASC').all(inc.id)}); });
router.post('/incidents/:uid/comments', authMiddleware, (req,res)=>{try{const{text}=req.body;if(!text?.trim())return res.status(400).json({error:'Empty'});const mod=moderateText(text);if(!mod.passed)return res.status(400).json({error:'Moderation'});const db=getDb();const inc=db.prepare('SELECT id,user_id FROM incidents WHERE uid=?').get(req.params.uid);if(!inc)return res.status(404).json({error:'Not found'});const r=db.prepare('INSERT INTO comments (incident_id,user_id,text) VALUES (?,?,?)').run(inc.id,req.user.id,text.trim());const c=db.prepare('SELECT c.*,u.username,u.avatar_color,u.reputation,u.trust_level,u.vk_photo FROM comments c JOIN users u ON c.user_id=u.id WHERE c.id=?').get(r.lastInsertRowid);if(inc.user_id!==req.user.id)db.prepare("INSERT INTO notifications (user_id,incident_id,type,message) VALUES (?,?,?,?)").run(inc.user_id,inc.id,'comment',`${req.user.username} прокомментировал`);checkAndAward(req.user.id);res.json({comment:c});}catch(e){res.status(500).json({error:'Error'});}});

router.get('/incidents/:uid/chat', (req,res)=>{const db=getDb();const inc=db.prepare('SELECT id FROM incidents WHERE uid=?').get(req.params.uid);if(!inc)return res.status(404).json({error:'Not found'});res.json({messages:db.prepare('SELECT m.*,u.username,u.avatar_color,u.vk_photo FROM chat_messages m JOIN users u ON m.user_id=u.id WHERE m.incident_id=? ORDER BY m.created_at DESC LIMIT 50').all(inc.id).reverse()});});
router.post('/incidents/:uid/chat', authMiddleware, (req,res)=>{const{text}=req.body;if(!text?.trim())return res.status(400).json({error:'Empty'});const db=getDb();const inc=db.prepare('SELECT id FROM incidents WHERE uid=?').get(req.params.uid);if(!inc)return res.status(404).json({error:'Not found'});const r=db.prepare('INSERT INTO chat_messages (incident_id,user_id,text) VALUES (?,?,?)').run(inc.id,req.user.id,text.trim());const m=db.prepare('SELECT m.*,u.username,u.avatar_color,u.vk_photo FROM chat_messages m JOIN users u ON m.user_id=u.id WHERE m.id=?').get(r.lastInsertRowid);res.json({message:m});});

router.get('/incidents/:uid/timeline', (req,res)=>{const db=getDb();const inc=db.prepare('SELECT id FROM incidents WHERE uid=?').get(req.params.uid);if(!inc)return res.status(404).json({error:'Not found'});res.json({timeline:db.prepare('SELECT t.*,u.username,u.avatar_color FROM incident_timeline t LEFT JOIN users u ON t.user_id=u.id WHERE t.incident_id=? ORDER BY t.created_at ASC').all(inc.id)});});

// ════════════════════════════════════
//  STREAMERS / SOS / PATROL
// ════════════════════════════════════
router.post('/incidents/:uid/claim', authMiddleware, (req,res)=>{const db=getDb();const inc=db.prepare('SELECT id FROM incidents WHERE uid=?').get(req.params.uid);if(!inc)return res.status(404).json({error:'Not found'});try{db.prepare('INSERT INTO streamer_claims (incident_id,user_id) VALUES (?,?)').run(inc.id,req.user.id);db.prepare("UPDATE incidents SET status='responding' WHERE id=? AND status='active'").run(inc.id);db.prepare('INSERT INTO incident_timeline (incident_id,user_id,event_type,description) VALUES (?,?,?,?)').run(inc.id,req.user.id,'streamer_claimed',`Стример ${req.user.username} выезжает`);checkAndAward(req.user.id);res.json({success:true});}catch(e){if(e.message?.includes('UNIQUE'))return res.status(409).json({error:'Already claimed'});throw e;}});

router.post('/sos', authMiddleware, (req,res)=>{const{lat,lng,description}=req.body;if(lat==null||lng==null)return res.status(400).json({error:'Coords required'});const db=getDb();const uid='sos_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');db.prepare("INSERT INTO incidents (uid,user_id,type,description,lat,lng,severity,is_emergency,status) VALUES (?,?,'sos',?,?,?,5,1,'active')").run(uid,req.user.id,description||'SOS! Нужна помощь!',parseFloat(lat),parseFloat(lng));const inc=db.prepare('SELECT * FROM incidents WHERE uid=?').get(uid);db.prepare('INSERT INTO incident_timeline (incident_id,user_id,event_type,description) VALUES (?,?,?,?)').run(inc.id,req.user.id,'sos','SOS активирован');notifyVk('/notify/sos',{...inc,username:req.user.username});res.json({incident:inc});});

router.patch('/patrol/toggle', authMiddleware, (req,res)=>{const db=getDb();const u=db.prepare('SELECT is_patrolling FROM users WHERE id=?').get(req.user.id);const v=u.is_patrolling?0:1;db.prepare('UPDATE users SET is_patrolling=? WHERE id=?').run(v,req.user.id);res.json({is_patrolling:v});});
router.post('/patrol/location', authMiddleware, (req,res)=>{const{lat,lng}=req.body;getDb().prepare('UPDATE users SET patrol_lat=?,patrol_lng=?,last_active=CURRENT_TIMESTAMP WHERE id=?').run(parseFloat(lat),parseFloat(lng),req.user.id);res.json({success:true});});
router.get('/patrol/active', (req,res)=>{res.json({patrols:getDb().prepare("SELECT id,username,avatar_color,patrol_lat,patrol_lng,vk_photo FROM users WHERE is_patrolling=1 AND patrol_lat IS NOT NULL AND last_active>datetime('now','-10 minutes')").all()});});

// ════════════════════════════════════
//  NOTIFICATIONS / ZONES
// ════════════════════════════════════
router.get('/notifications', authMiddleware, (req,res)=>{const db=getDb();const n=db.prepare('SELECT n.*,i.uid as incident_uid,i.type as incident_type FROM notifications n LEFT JOIN incidents i ON n.incident_id=i.id WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT 50').all(req.user.id);const u=db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).c;res.json({notifications:n,unread:u});});
router.patch('/notifications/read', authMiddleware, (req,res)=>{getDb().prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);res.json({success:true});});
router.get('/zones', authMiddleware, (req,res)=>{res.json({zones:getDb().prepare('SELECT * FROM user_zones WHERE user_id=?').all(req.user.id)});});
router.post('/zones', authMiddleware, (req,res)=>{const{label,lat,lng,radius_km}=req.body;if(lat==null||lng==null)return res.status(400).json({error:'Coords'});const db=getDb();try{db.prepare('INSERT INTO user_zones (user_id,label,lat,lng,radius_km) VALUES (?,?,?,?,?)').run(req.user.id,label||'Мой район',lat,lng,radius_km||2);res.json({success:true});}catch{db.prepare('UPDATE user_zones SET lat=?,lng=?,radius_km=? WHERE user_id=? AND label=?').run(lat,lng,radius_km||2,req.user.id,label||'Мой район');res.json({success:true});}});

// ════════════════════════════════════
//  ANALYTICS
// ════════════════════════════════════
router.get('/analytics/overview', (req,res)=>{const db=getDb();
  const byType=db.prepare("SELECT type,COUNT(*) as count FROM incidents WHERE created_at>datetime('now','-7 days') AND status!='fake' GROUP BY type ORDER BY count DESC").all();
  const byHour=db.prepare("SELECT strftime('%H',created_at) as hour,COUNT(*) as count FROM incidents WHERE created_at>datetime('now','-24 hours') AND status!='fake' GROUP BY hour ORDER BY hour").all();
  const byDayOfWeek=db.prepare("SELECT CAST(strftime('%w',created_at) AS INTEGER) as dow,COUNT(*) as count FROM incidents WHERE created_at>datetime('now','-30 days') AND status!='fake' GROUP BY dow").all();
  const totals=db.prepare("SELECT COUNT(*) as total,SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) as confirmed,SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved FROM incidents WHERE created_at>datetime('now','-7 days')").get();
  const streamers=db.prepare("SELECT COUNT(DISTINCT user_id) as count FROM streamer_claims WHERE status!='finished' AND claimed_at>datetime('now','-24 hours')").get();
  const avg=db.prepare("SELECT AVG((julianday(arrived_at)-julianday(claimed_at))*24*60) as m FROM streamer_claims WHERE arrived_at IS NOT NULL AND claimed_at>datetime('now','-7 days')").get();
  const heatmap=db.prepare("SELECT lat,lng,type FROM incidents WHERE created_at>datetime('now','-7 days') AND status!='fake'").all();
  res.json({byType,byHour,byDayOfWeek,heatmap,totals:{...totals,active_streamers:streamers.count,avg_response_min:avg?.m?Math.round(avg.m):null}});
});
router.get('/analytics/leaderboard', (req,res)=>{res.json({leaderboard:getDb().prepare("SELECT u.id,u.username,u.avatar_color,u.reputation,u.is_streamer,u.trust_level,u.vk_photo,(SELECT COUNT(*) FROM incidents WHERE user_id=u.id AND status!='fake') as reports,(SELECT COUNT(*) FROM votes WHERE user_id=u.id) as votes_cast,(SELECT COUNT(*) FROM comments WHERE user_id=u.id) as comments_made,(SELECT COUNT(*) FROM achievements WHERE user_id=u.id) as achievement_count FROM users u ORDER BY u.reputation DESC LIMIT 20").all()});});
router.get('/analytics/safety', (req,res)=>{const{lat,lng}=req.query;if(!lat||!lng)return res.status(400).json({error:'lat & lng'});const r=0.02;const inc=getDb().prepare('SELECT type,COUNT(*) as count FROM incidents WHERE lat BETWEEN ?-? AND ?+? AND lng BETWEEN ?-? AND ?+? AND created_at>datetime(\'now\',\'-30 days\') AND status!=\'fake\' GROUP BY type').all(parseFloat(lat),r,parseFloat(lat),r,parseFloat(lng),r,parseFloat(lng),r);const t=inc.reduce((s,i)=>s+i.count,0);const sc=Math.max(0,Math.round(100-t*3));res.json({score:sc,level:sc>=80?'safe':sc>=50?'moderate':'dangerous',total_incidents:t,breakdown:inc});});

// ═══ USER PROFILE ═══
router.get('/users/:id/profile', (req,res)=>{const db=getDb();const u=db.prepare('SELECT id,username,avatar_color,reputation,is_streamer,trust_level,vk_id,vk_name,vk_photo,created_at FROM users WHERE id=?').get(req.params.id);if(!u)return res.status(404).json({error:'Not found'});const s={reports:db.prepare("SELECT COUNT(*) as c FROM incidents WHERE user_id=? AND status!='fake'").get(u.id).c,confirmed:db.prepare("SELECT COUNT(*) as c FROM incidents WHERE user_id=? AND status='confirmed'").get(u.id).c,votes:db.prepare('SELECT COUNT(*) as c FROM votes WHERE user_id=?').get(u.id).c,comments:db.prepare('SELECT COUNT(*) as c FROM comments WHERE user_id=?').get(u.id).c,streams:db.prepare('SELECT COUNT(*) as c FROM streamer_claims WHERE user_id=?').get(u.id).c};const bt=db.prepare("SELECT type,COUNT(*) as count FROM incidents WHERE user_id=? AND status!='fake' GROUP BY type").all(u.id);res.json({user:u,stats:s,byType:bt,achievements:getUserAchievements(u.id)});});
router.get('/achievements', authMiddleware, (req,res)=>{res.json({achievements:getUserAchievements(req.user.id)});});

// ═══ EMERGENCY (mod only) ═══
router.post('/emergency', authMiddleware, modOnly, (req,res)=>{const{title,message,lat,lng,radius_km}=req.body;if(!title||!message||lat==null||lng==null)return res.status(400).json({error:'Fill all'});getDb().prepare('INSERT INTO emergency_alerts (user_id,title,message,lat,lng,radius_km) VALUES (?,?,?,?,?,?)').run(req.user.id,title,message,lat,lng,radius_km||5);notifyVk('/notify/emergency',{title,message,lat,lng,radius_km});res.json({success:true});});
router.get('/emergency/active', (req,res)=>{res.json({alerts:getDb().prepare("SELECT * FROM emergency_alerts WHERE active=1 AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP) ORDER BY created_at DESC").all()});});

// ═══ VK CONFIG (public) ═══
router.get('/vk/config', (req, res) => {
  res.json({ app_id: process.env.VK_APP_ID || '', enabled: !!(process.env.VK_APP_ID && process.env.VK_APP_SECRET) });
});

module.exports = router;
