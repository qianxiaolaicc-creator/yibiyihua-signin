import { HttpError, fail, readJson } from './request.mjs';
import { exportSnapshot, restoreSnapshot, readScheduledBackup, MAX_SNAPSHOT_BYTES } from './backup.mjs';
const DAY=86400000;
const SESSION_DAYS=14;
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});


const rand=(n=32)=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
const id=()=>crypto.randomUUID();
const encode=s=>new TextEncoder().encode(s);
const hex=b=>Array.from(new Uint8Array(b),b=>b.toString(16).padStart(2,'0')).join('');
const hash=async s=>hex(await crypto.subtle.digest('SHA-256',encode(s)));
const nameKey=s=>String(s).trim().replace(/\s+/g,'');
const timestamp=()=>new Date().toISOString();
export const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
function validDate(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='2000-01-01'&&v<=today()&&!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v}
async function derive(password,salt){const key=await crypto.subtle.importKey('raw',encode(password),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encode(salt),iterations:100000},key,256))}
function safeEqual(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0}
const cookie=(token,ttl=SESSION_DAYS*86400)=>`yb_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
function textField(v,label,max=80){if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(400,`${label}不能为空，且不能超过 ${max} 个字符。`);return v.trim()}
function passwordField(v,label='密码'){if(typeof v!=='string'||!v.length||v.length>128)fail(400,`${label}不能为空，且不能超过128个字符。`);return v}
function identifier(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))fail(400,'编号格式无效。');return value}
function configuredSetupKey(env){return typeof env.ADMIN_SETUP_KEY==='string'&&env.ADMIN_SETUP_KEY.length>=32&&env.ADMIN_SETUP_KEY.length<=128}
function balanceField(v){if(!Number.isInteger(v)||v<0||v>9999)fail(400,'课时必须是 0–9999 的整数。');return v}
const bodyOf = req => readJson(req, 12000);
async function rate(db,key,limit,windowMs){const now=Date.now(),bucket=Math.floor(now/windowMs),k=await hash(`${key}:${bucket}`);const row=await db.prepare('INSERT INTO request_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(k,now+windowMs).first();if(row.count>limit)fail(429,'操作过于频繁，请稍后再试。',{retryAfter:Math.ceil(windowMs/1000)});if(Math.random()<0.02)await db.prepare('DELETE FROM request_limits WHERE expires_at < ?').bind(now).run()}
async function getAdminSession(req,db){const token=(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('yb_session='))?.slice(11);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const row=await db.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>?').bind(await hash(token),Date.now()).first();return row?.token_hash||null}
async function requireAdmin(req,db){const s=await getAdminSession(req,db);if(!s)fail(401,'请先登录管理员账号。');return s}
async function session(db){const token=rand();await db.batch([db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(Date.now()),db.prepare('INSERT INTO admin_sessions (token_hash,expires_at) VALUES (?,?)').bind(await hash(token),Date.now()+SESSION_DAYS*DAY)]);return token}
async function getStudent(db,studentId,withAudit=false){const s=await db.prepare('SELECT id,code,name,class_name,balance,parent_code FROM students WHERE id=?').bind(studentId).first();if(!s)fail(404,'学生档案不存在。');const records=(await db.prepare('SELECT id,lesson_date AS date,created_at AS created FROM lessons WHERE student_id=? AND active=1 ORDER BY lesson_date DESC,created_at DESC').bind(studentId).all()).results;const a=withAudit?(await db.prepare('SELECT description,created_at FROM audit_log WHERE student_id=? ORDER BY created_at DESC LIMIT 200').bind(studentId).all()).results.map(x=>`${x.created_at.slice(0,10)} · ${x.description}`):[];return {id:s.id,code:s.code,name:s.name,group:s.class_name,balance:s.balance,records,audit:a,...(withAudit?{parentCode:s.parent_code}:{})}}
function auditStmt(db,studentId,action,description){return db.prepare('INSERT INTO audit_log (id,student_id,action,description,created_at) VALUES (?,?,?,?,?)').bind(id(),studentId,action,description,timestamp())}
export async function handleApi(req,env){try{const db=env.DB;if(!db)fail(503,'数据库暂不可用，请稍后重试。');const url=new URL(req.url),path=url.pathname.replace(/\/$/,'');if(req.method==='POST'){const origin=req.headers.get('origin');if(origin!==url.origin)fail(403,'请求来源无效，请从本站重新操作。')}
const ip=req.headers.get('cf-connecting-ip')||'unknown';
if(path==='/api/status'&&req.method==='GET'){const admin=await db.prepare('SELECT username FROM administrator WHERE id=1').first();return json({configured:!!admin,authenticated:!!(await getAdminSession(req,db)),setupAllowed:!admin&&configuredSetupKey(env)})}
if(path==='/api/setup'&&req.method==='POST'){if(!configuredSetupKey(env))fail(403,'管理员初始化尚未启用。');await rate(db,'setup:'+ip,5,900000);const b=await bodyOf(req);if(typeof b.setupKey!=='string'||b.setupKey.length>128||!safeEqual(await hash(b.setupKey),await hash(env.ADMIN_SETUP_KEY)))fail(403,'初始化密钥不正确。');if(await db.prepare('SELECT id FROM administrator WHERE id=1').first())fail(409,'管理员已设置，请直接登录。');const username=textField(b.username,'账号',40),password=passwordField(b.password);if(password.length<10)fail(400,'密码至少需要 10 个字符。');if(password!==b.confirmPassword)fail(400,'两次输入的密码不一致。');const salt=rand(16),passwordHash=await derive(password,salt);try{await db.prepare('INSERT INTO administrator (id,username,password_hash,salt,created_at) VALUES (1,?,?,?,?)').bind(username,passwordHash,salt,timestamp()).run()}catch(e){if(String(e).includes('UNIQUE'))fail(409,'管理员已设置，请直接登录。');throw e}return json({ok:true},201,{'Set-Cookie':cookie(await session(db))})}
if(path==='/api/login'&&req.method==='POST'){await rate(db,'login-ip:'+ip,10,900000);const b=await bodyOf(req),username=textField(b.username,'账号',40),password=passwordField(b.password);const admin=await db.prepare('SELECT username,password_hash,salt FROM administrator WHERE id=1').first();if(!admin)fail(409,'请先完成管理员首次设置。');const h=await derive(password,admin.salt);if(!safeEqual(h,admin.password_hash)||username!==admin.username)fail(401,'账号或密码不正确。');return json({ok:true},200,{'Set-Cookie':cookie(await session(db))})}
if(path==='/api/logout'&&req.method==='POST'){const token=await getAdminSession(req,db);if(token)await db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(token).run();return json({ok:true},200,{'Set-Cookie':cookie('',0)})}
if(path==='/api/search'&&req.method==='POST'){
  await rate(db,'search:'+ip,20,60000);
  const b=await bodyOf(req);
  const name=nameKey(textField(b.name,'姓名',30));
  const code=typeof b.code==='string'?b.code.replace(/[\s-]+/g,'').toUpperCase():'';
  if(!/^[A-F0-9]{16}$/.test(code))fail(400,'请输入老师提供的16位查询码。');
  const row=await db.prepare('SELECT id FROM students WHERE parent_code=? AND name_key=?').bind(code,name).first();
  if(!row)return json({students:[]});
  const student=await getStudent(db,row.id);
  student.records=student.records.map(({date})=>({date}));
  return json({students:[student]});
}
if(path.startsWith('/api/admin/')){await requireAdmin(req,db);
if(path==='/api/admin/students'&&req.method==='GET'){const rows=(await db.prepare('SELECT id,code,name,class_name AS "group",balance FROM students ORDER BY created_at DESC').all()).results;return json({students:rows})}
if(path==='/api/admin/student'&&req.method==='GET')return json({student:await getStudent(db,url.searchParams.get('id')||'',true)});
if(path==='/api/admin/students'&&req.method==='POST'){const b=await bodyOf(req),name=textField(b.name,'姓名',30),group=textField(b.group,'班级',40),balance=balanceField(b.balance),studentId=b.requestId?identifier(b.requestId):id(),code='YB'+rand(4).toUpperCase();const prior=await db.prepare('SELECT name_key,class_name FROM students WHERE id=?').bind(studentId).first();if(prior){if(prior.name_key!==nameKey(name)||prior.class_name!==group)fail(409,'该请求已保存，请刷新查看。');return json({student:await getStudent(db,studentId,true),alreadySaved:true})}await db.batch([db.prepare('INSERT INTO students (id,code,name,name_key,class_name,balance,created_at,parent_code) VALUES (?,?,?,?,?,?,?,?)').bind(studentId,code,name,nameKey(name),group,balance,timestamp(),rand(8).toUpperCase()),auditStmt(db,studentId,'create',`建立档案，初始剩余 ${balance} 课时`)]);return json({student:await getStudent(db,studentId,true)},201)}
if(path==='/api/admin/profile'&&req.method==='POST'){const b=await bodyOf(req),studentId=identifier(b.id),s=await getStudent(db,studentId),name=textField(b.name,'姓名',30),group=textField(b.group,'班级',40);await db.batch([db.prepare('UPDATE students SET name=?,name_key=?,class_name=? WHERE id=?').bind(name,nameKey(name),group,studentId),auditStmt(db,studentId,'profile',`档案修改：${s.name} / ${s.group} → ${name} / ${group}`)]);return json({student:await getStudent(db,studentId,true)})}
if(path==='/api/admin/balance'&&req.method==='POST'){const b=await bodyOf(req),studentId=identifier(b.id),balance=balanceField(b.balance),expected=balanceField(b.expectedBalance),reason=textField(b.reason,'调整原因',120);const result=await db.batch([db.prepare('UPDATE students SET balance=? WHERE id=? AND balance=?').bind(balance,studentId,expected),db.prepare('INSERT INTO audit_log(id,student_id,action,description,created_at) SELECT ?,?,?,?,? WHERE changes()=1').bind(id(),studentId,'balance',`剩余课时 ${expected} → ${balance}；原因：${reason}`,timestamp())]);if(!result[0].meta.changes)fail(409,'课时已被其他操作更新，请刷新后核对。');return json({student:await getStudent(db,studentId,true)})}
if(path==='/api/admin/lesson'&&req.method==='POST'){const b=await bodyOf(req),studentId=identifier(b.id),requestId=identifier(b.requestId);if(!validDate(b.date))fail(400,'请选择有效的上课日期，不能记录未来日期。');if(!Number.isInteger(b.expectedCount)||b.expectedCount<0)fail(400,'请重新确认当天上课次数。');const existing=await db.prepare('SELECT student_id,lesson_date FROM lessons WHERE id=?').bind(requestId).first();if(existing){if(existing.student_id!==studentId||existing.lesson_date!==b.date)fail(409,'请求已被使用。');return json({student:await getStudent(db,studentId,true),alreadySaved:true})}try{const result=await db.prepare('INSERT INTO lessons(id,student_id,lesson_date,active,created_at) SELECT ?,?,?,1,? WHERE (SELECT count(*) FROM lessons WHERE student_id=? AND lesson_date=? AND active=1)=?').bind(requestId,studentId,b.date,timestamp(),studentId,b.date,b.expectedCount).run();if(!result.meta.changes)fail(409,'当天上课记录已变化，请刷新后确认是否增加一次。')}catch(e){if(String(e).includes('INSUFFICIENT_BALANCE'))fail(409,'剩余课时不足，请先核对余额。');if(String(e).includes('UNIQUE constraint failed: lessons.id')){const prior=await db.prepare('SELECT student_id,lesson_date FROM lessons WHERE id=?').bind(requestId).first();if(prior?.student_id===studentId&&prior.lesson_date===b.date)return json({student:await getStudent(db,studentId,true),alreadySaved:true});fail(409,'请求已被使用。');}throw e}return json({student:await getStudent(db,studentId,true)},201)}
if(path==='/api/admin/lesson/undo'&&req.method==='POST'){const b=await bodyOf(req),studentId=identifier(b.id),lessonId=identifier(b.lessonId);const existing=await db.prepare('SELECT id FROM lessons WHERE id=? AND student_id=?').bind(lessonId,studentId).first();if(!existing)fail(404,'上课记录不存在。');await db.prepare('UPDATE lessons SET active=0,voided_at=? WHERE id=? AND student_id=? AND active=1').bind(timestamp(),lessonId,studentId).run();return json({student:await getStudent(db,studentId,true)})}
if(path==='/api/admin/password'&&req.method==='POST'){await rate(db,'password:'+ip,10,900000);const b=await bodyOf(req),oldPassword=passwordField(b.oldPassword,'当前密码'),newPassword=passwordField(b.password,'新密码');if(newPassword.length<10||newPassword!==b.confirmPassword)fail(400,'新密码至少 10 个字符，且两次输入须一致。');const admin=await db.prepare('SELECT password_hash,salt FROM administrator WHERE id=1').first();if(!safeEqual(await derive(oldPassword,admin.salt),admin.password_hash))fail(401,'当前密码不正确。');const salt=rand(16),passwordHash=await derive(newPassword,salt);await db.batch([db.prepare('UPDATE administrator SET password_hash=?,salt=? WHERE id=1').bind(passwordHash,salt),db.prepare('DELETE FROM admin_sessions')]);return json({ok:true},200,{'Set-Cookie':cookie(await session(db))})}
if(path==='/api/admin/parent-code'&&req.method==='POST'){
  const b=await bodyOf(req), studentId=identifier(b.id), code=rand(8).toUpperCase();
  if(!await db.prepare('SELECT id FROM students WHERE id=?').bind(studentId).first())fail(404,'学生档案不存在。');
  await db.batch([
    db.prepare('UPDATE students SET parent_code=? WHERE id=?').bind(code,studentId),
    auditStmt(db,studentId,'parent-code','更新了家长查询码'),
  ]);
  return json({student:await getStudent(db,studentId,true)});
}
if(path==='/api/admin/export'&&req.method==='GET'){
  const snapshot=await exportSnapshot(db);
  if(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength>MAX_SNAPSHOT_BYTES)fail(413,'数据量超过网页备份上限，请使用数据库管理台导出。');
  return json(snapshot,200,{'Content-Disposition':`attachment; filename="yibiyihua-backup-${today()}.json"`});
}
if(path==='/api/admin/restore'&&req.method==='POST'){
  const {status,...result}=await restoreSnapshot(req,db);
  return json(result,status);
}
if(path==='/api/admin/backups'&&req.method==='GET'){
  if(!env.BACKUPS||!env.BACKUP_KEY)return json({dates:[]});
  const rows=(await env.BACKUPS.prepare('SELECT date FROM snapshots ORDER BY date DESC').all()).results;
  return json({dates:rows.map(row=>row.date)});
}
if(path==='/api/admin/backup'&&req.method==='GET'&&env.BACKUPS&&env.BACKUP_KEY){
  const day=url.searchParams.get('date');
  const data=await readScheduledBackup(env,day);
  if(!data)fail(404,'未找到这一天的备份。');
  return new Response(data,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="yibiyihua-backup-${day}.json"`}});
}
}
return json({error:'接口不存在。'},404);
}catch(e){if(e instanceof HttpError)return json({error:e.message,...e.data},e.status);console.error('API failure',e?.name);return json({error:'保存或查询失败，请稍后重试。'},500)}}
