const { getDb } = require('./database');
const ACHIEVEMENTS = {
  first_report:{icon:'🏅',name:'Первый репорт',name_en:'First Report',check:u=>u.reports>=1},
  reporter_10:{icon:'📰',name:'Репортёр',name_en:'Reporter',check:u=>u.reports>=10},
  night_watch:{icon:'🌙',name:'Ночной дозор',name_en:'Night Watch',check:u=>u.night_reports>=1},
  detective:{icon:'🔍',name:'Детектив',name_en:'Detective',check:u=>u.confirmed>=10},
  guardian:{icon:'🛡️',name:'Страж',name_en:'Guardian',check:u=>u.fakes_found>=5},
  commentator:{icon:'💬',name:'Комментатор',name_en:'Commentator',check:u=>u.comments>=20},
  streamer_first:{icon:'🎥',name:'На месте!',name_en:'On Scene!',check:u=>u.streams>=1},
  voter:{icon:'✅',name:'Активист',name_en:'Activist',check:u=>u.votes>=50},
  reputation_100:{icon:'⭐',name:'Авторитет',name_en:'Authority',check:u=>u.reputation>=100},
};
function checkAndAward(userId) {
  const db = getDb();
  const existing = new Set(db.prepare('SELECT achievement_key FROM achievements WHERE user_id=?').all(userId).map(a=>a.achievement_key));
  const s = db.prepare(`SELECT
    (SELECT COUNT(*) FROM incidents WHERE user_id=? AND status!='fake') as reports,
    (SELECT COUNT(*) FROM incidents WHERE user_id=? AND status='confirmed') as confirmed,
    (SELECT COUNT(*) FROM incidents WHERE user_id=? AND status!='fake' AND CAST(strftime('%H',created_at) AS INTEGER)<5) as night_reports,
    (SELECT COUNT(*) FROM votes WHERE user_id=?) as votes,
    (SELECT COUNT(*) FROM votes v JOIN incidents i ON v.incident_id=i.id WHERE v.user_id=? AND v.vote_type='fake' AND i.status='fake') as fakes_found,
    (SELECT COUNT(*) FROM comments WHERE user_id=?) as comments,
    (SELECT COUNT(*) FROM streamer_claims WHERE user_id=?) as streams,
    (SELECT reputation FROM users WHERE id=?) as reputation
  `).get(userId,userId,userId,userId,userId,userId,userId,userId);
  const r=[];
  for(const[k,a]of Object.entries(ACHIEVEMENTS)){if(existing.has(k))continue;if(a.check(s)){try{db.prepare('INSERT INTO achievements (user_id,achievement_key) VALUES (?,?)').run(userId,k);r.push({key:k,...a});}catch{}}}
  return r;
}
function getUserAchievements(userId) {
  const db = getDb();
  const u = db.prepare('SELECT achievement_key,unlocked_at FROM achievements WHERE user_id=?').all(userId);
  return Object.entries(ACHIEVEMENTS).map(([k,a])=>{const f=u.find(x=>x.achievement_key===k);return{key:k,...a,unlocked:!!f,unlocked_at:f?.unlocked_at||null};});
}
module.exports = { ACHIEVEMENTS, checkAndAward, getUserAchievements };
