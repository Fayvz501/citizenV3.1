const BAD_WORDS=['спам','реклама','продам','купи','казино','ставки','тест123'];
const SUS=[/(.)\1{5,}/i,/https?:\/\//i,/t\.me\//i,/\b\d{10,}\b/];
function moderateText(text){const l=text.toLowerCase();let s=0,f=[];
for(const w of BAD_WORDS)if(l.includes(w)){s+=0.3;f.push(w);}
for(const p of SUS)if(p.test(text)){s+=0.2;f.push('pattern');}
if(text.length<5){s+=0.3;f.push('short');}
return{score:Math.min(s,1),flags:f,passed:s<0.5};}
module.exports={moderateText};
