import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomBytes, createHash, randomInt } from "node:crypto";

// Carga perezosa: si una dependencia o la URL de Turso fallan, el error se devuelve como JSON
// (en vez de tumbar la función con FUNCTION_INVOCATION_FAILED).
let _db:any=null;
async function getDb(){
  if(_db)return _db;
  const {createClient}=await import("@libsql/client");
  _db=createClient({url:(process.env.TURSO_DATABASE_URL||"").trim(),authToken:(process.env.TURSO_AUTH_TOKEN||"").trim()});
  return _db;
}
const db={execute:async(q:any):Promise<any>=>(await getDb()).execute(q)};
const hash = (s:string) => createHash("sha256").update(s + (process.env.SESSION_SECRET || "chatly-dev-secret-change-me")).digest("hex");
const token = (bytes=32) => randomBytes(bytes).toString("base64url");
const id = () => randomBytes(16).toString("hex");
const countries:Record<string,{dial:string;digits:number}> = {
  HN:{dial:"+504",digits:8}, US:{dial:"+1",digits:10}, CA:{dial:"+1",digits:10}, MX:{dial:"+52",digits:10},
  CO:{dial:"+57",digits:10}, GT:{dial:"+502",digits:8}, SV:{dial:"+503",digits:8}, CR:{dial:"+506",digits:8},
  PA:{dial:"+507",digits:8}, NI:{dial:"+505",digits:8}, ES:{dial:"+34",digits:9}, AR:{dial:"+54",digits:10},
  CL:{dial:"+56",digits:9}, PE:{dial:"+51",digits:9}, EC:{dial:"+593",digits:9}, BR:{dial:"+55",digits:11},
  GB:{dial:"+44",digits:10}, FR:{dial:"+33",digits:9}, DE:{dial:"+49",digits:10}, IT:{dial:"+39",digits:10},
  JP:{dial:"+81",digits:10}, IN:{dial:"+91",digits:10}, AU:{dial:"+61",digits:9}, PH:{dial:"+63",digits:10}
};
let schemaReady:Promise<void>|null=null;
async function initDb(){
  if(!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)
    throw Object.assign(new Error("Falta configurar TURSO_DATABASE_URL y TURSO_AUTH_TOKEN en .env o Vercel."),{status:503});
  if(process.env.NODE_ENV==="production" && !process.env.SESSION_SECRET)
    throw Object.assign(new Error("Falta configurar SESSION_SECRET en Vercel."),{status:503});
  if(schemaReady)return schemaReady;
  schemaReady=(async()=>{
    const statements=[
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, country TEXT NOT NULL, chat_number TEXT NOT NULL UNIQUE, recovery_hash TEXT NOT NULL, status_text TEXT NOT NULL DEFAULT 'Disponible', avatar_url TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, fcm_token TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_seen TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id,active)`,
      `CREATE TABLE IF NOT EXISTS contacts (user_id TEXT NOT NULL, contact_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,contact_id))`,
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, recipient_id TEXT, group_id TEXT, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', created_at TEXT NOT NULL, edited_at TEXT, deleted_at TEXT, read_at TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id,recipient_id,created_at)`,
      `CREATE TABLE IF NOT EXISTS chat_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL, PRIMARY KEY(group_id,user_id))`,
      `CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS channel_posts (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS statuses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL, media_url TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(blocker_id,blocked_id))`,
      `CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS pinned_messages (user_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,message_id))`,
      `CREATE TABLE IF NOT EXISTS reactions (user_id TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,message_id,emoji))`
    ];
    for(const sql of statements) await db.execute(sql);
  })();
  return schemaReady;
}
async function firebaseAdmin(){
  if(!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  const {cert,getApps,initializeApp}=await import("firebase-admin/app");
  const {getMessaging}=await import("firebase-admin/messaging");
  if(!getApps().length){
    const service=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if(!service.project_id||!service.client_email||!service.private_key)throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON no contiene una cuenta de servicio válida.");
    if(process.env.VITE_FIREBASE_PROJECT_ID&&service.project_id!==process.env.VITE_FIREBASE_PROJECT_ID)throw new Error("La cuenta de servicio pertenece a otro proyecto Firebase.");
    initializeApp({credential:cert(service),projectId:service.project_id});
  }
  return getMessaging();
}
async function pushTo(userId:string,title:string,body:string,data:Record<string,string>={}){
  const messaging=await firebaseAdmin();
  if(!messaging)return {configured:false,sent:0,failed:0,reason:"missing-admin-credentials"};
  const rows=await db.execute({sql:"SELECT fcm_token FROM sessions WHERE user_id=? AND active=1 AND fcm_token IS NOT NULL",args:[userId]});
  const tokens=rows.rows.map(r=>String(r.fcm_token)).filter(Boolean);
  if(!tokens.length)return {configured:true,sent:0,failed:0,reason:"no-device-token"};
  const results=await Promise.all(tokens.map(async t=>{
    try{await messaging.send({token:t,notification:{title,body},data:{url:"/",...data}});return true}
    catch(e){
      const message=String(e);console.error("Chatly FCM send failed:",message);
      if(message.includes("registration-token-not-registered")||message.includes("invalid-registration-token")||message.includes("Requested entity was not found"))
        await db.execute({sql:"UPDATE sessions SET fcm_token=NULL WHERE fcm_token=?",args:[t]});
      return false;
    }
  }));
  return {configured:true,sent:results.filter(Boolean).length,failed:results.filter(x=>!x).length};
}
async function auth(req:VercelRequest){
  const raw=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  if(!raw)throw Object.assign(new Error("Inicia sesión para continuar."),{status:401});
  const result=await db.execute({sql:"SELECT s.id AS session_id,s.user_id,u.display_name,u.chat_number,u.country,u.status_text FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.active=1 LIMIT 1",args:[hash(raw)]});
  if(!result.rows[0])throw Object.assign(new Error("Sesión no válida. Vuelve a iniciar sesión."),{status:401});
  const r=result.rows[0];
  await db.execute({sql:"UPDATE sessions SET last_seen=? WHERE id=?",args:[new Date().toISOString(),r.session_id]});
  return {sessionId:String(r.session_id),userId:String(r.user_id),name:String(r.display_name),number:String(r.chat_number),country:String(r.country),status:String(r.status_text)};
}
function respond(res:VercelResponse,status:number,data:unknown){return res.status(status).json(data)}
export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader("Cache-Control","no-store");
  if(req.method==="OPTIONS")return res.status(204).end();
  try{
    await initDb();
    const action=String(req.query.action||"");
    if(action==="public-config"&&req.method==="GET"){
      return respond(res,200,{firebase:{
        apiKey:process.env.VITE_FIREBASE_API_KEY||"",authDomain:process.env.VITE_FIREBASE_AUTH_DOMAIN||"",
        projectId:process.env.VITE_FIREBASE_PROJECT_ID||"",messagingSenderId:process.env.VITE_FIREBASE_MESSAGING_SENDER_ID||"",
        appId:process.env.VITE_FIREBASE_APP_ID||"",
        storageBucket:process.env.VITE_FIREBASE_STORAGE_BUCKET||"",
        measurementId:process.env.VITE_FIREBASE_MEASUREMENT_ID||""
      }});
    }
    if(action==="health"&&req.method==="GET"){
      const dbCheck=await db.execute("SELECT 1 AS ok");
      const tables=await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','contacts','messages','chat_groups','group_members','channels','channel_posts','statuses','blocks','reports','pinned_messages','reactions')");
      return respond(res,200,{ok:true,database:dbCheck.rows.length>0?"connected":"error",schemaTables:tables.rows.length,expectedTables:13,firebaseWeb:!!(process.env.VITE_FIREBASE_API_KEY&&process.env.VITE_FIREBASE_PROJECT_ID&&process.env.VITE_FIREBASE_MESSAGING_SENDER_ID&&process.env.VITE_FIREBASE_APP_ID),firebaseAdmin:!!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,vapid:!!process.env.VITE_FIREBASE_VAPID_KEY});
    }
    if(action==="numbers"&&req.method==="GET"){
      const country=String(req.query.country||"");const c=countries[country];
      if(!c)return respond(res,400,{error:"País no admitido."});
      const list:string[]=[];let attempts=0;
      while(list.length<6&&attempts<120){
        attempts++;
        const digits=Array.from({length:c.digits},()=>randomInt(0,10)).join("");
        const formatted=digits.length>7?digits.slice(0,3)+" "+digits.slice(3,6)+" "+digits.slice(6):digits;
        const candidate=c.dial+" "+formatted;
        const exists=await db.execute({sql:"SELECT 1 FROM users WHERE chat_number=? LIMIT 1",args:[candidate]});
        if(!exists.rows.length&&!list.includes(candidate))list.push(candidate);
      }
      if(!list.length)return respond(res,503,{error:"No hay identificadores disponibles en este momento. Inténtalo de nuevo."});
      return respond(res,200,{numbers:list});
    }
    if(action==="register"&&req.method==="POST"){
      const {displayName,country,chatNumber,deviceId,fcmToken}=req.body||{};
      if(typeof displayName!=="string"||displayName.trim().length<2||displayName.trim().length>40)return respond(res,400,{error:"El nombre debe tener entre 2 y 40 caracteres."});
      const c=countries[String(country)];if(!c)return respond(res,400,{error:"Selecciona un país válido."});
      if(typeof chatNumber!=="string"||!chatNumber.startsWith(c.dial+" "))return respond(res,400,{error:"El número no corresponde al país seleccionado."});
      const national=chatNumber.slice(c.dial.length+1).replace(/\s/g,"");
      if(!new RegExp(`^\\d{${c.digits}}$`).test(national))return respond(res,400,{error:"El formato del número no es válido."});
      if(typeof deviceId!=="string"||deviceId.length<12)return respond(res,400,{error:"No se pudo identificar este dispositivo."});
      const userId=id(),recoveryCode=token(8).toUpperCase(),sessionToken=token(32),sessionId=id(),created=new Date().toISOString();
      try{
        await db.execute({sql:"INSERT INTO users(id,display_name,country,chat_number,recovery_hash,created_at) VALUES(?,?,?,?,?,?)",args:[userId,displayName.trim(),country,chatNumber,hash(recoveryCode),created]});
      }catch{return respond(res,409,{error:"Ese número acaba de ser elegido. Genera otra lista y selecciona uno disponible."})}
      await db.execute({sql:"INSERT INTO sessions(id,user_id,token_hash,device_id,fcm_token,active,created_at,last_seen) VALUES(?,?,?,?,?,1,?,?)",args:[sessionId,userId,hash(sessionToken),deviceId,typeof fcmToken==="string"?fcmToken:null,created,created]});
      return respond(res,201,{token:sessionToken,recoveryCode,user:{id:userId,name:displayName.trim(),number:chatNumber,country}});
    }
    if(action==="login"&&req.method==="POST"){
      const {chatNumber,recoveryCode,deviceId,fcmToken}=req.body||{};
      if(!chatNumber||!recoveryCode||!deviceId)return respond(res,400,{error:"Escribe tu número y código de recuperación."});
      const u=await db.execute({sql:"SELECT id,display_name,chat_number,country,recovery_hash FROM users WHERE chat_number=? LIMIT 1",args:[String(chatNumber)]});
      const user=u.rows[0];if(!user||user.recovery_hash!==hash(String(recoveryCode).trim().toUpperCase()))return respond(res,401,{error:"Número o código de recuperación incorrectos."});
      const sessionToken=token(32),sessionId=id(),created=new Date().toISOString();
      await db.execute({sql:"UPDATE sessions SET active=0 WHERE user_id=?",args:[user.id]});
      await db.execute({sql:"INSERT INTO sessions(id,user_id,token_hash,device_id,fcm_token,active,created_at,last_seen) VALUES(?,?,?,?,?,1,?,?)",args:[sessionId,user.id,hash(sessionToken),String(deviceId),typeof fcmToken==="string"?fcmToken:null,created,created]});
      return respond(res,200,{token:sessionToken,user:{id:user.id,name:user.display_name,number:user.chat_number,country:user.country}});
    }
    const me=await auth(req);
    if(action==="me"&&req.method==="GET")return respond(res,200,{user:{id:me.userId,name:me.name,number:me.number,country:me.country,status:me.status}});
    if(action==="logout"&&req.method==="POST"){
      await db.execute({sql:"UPDATE sessions SET active=0,fcm_token=NULL WHERE id=?",args:[me.sessionId]});
      return respond(res,200,{ok:true});
    }
    if(action==="push-token"&&req.method==="POST"){
      const {fcmToken}=req.body||{};if(typeof fcmToken!=="string"||fcmToken.length<20)return respond(res,400,{error:"Token push no válido."});
      await db.execute({sql:"UPDATE sessions SET fcm_token=? WHERE id=?",args:[fcmToken,me.sessionId]});
      return respond(res,200,{ok:true});
    }
    if(action==="push-status"&&req.method==="GET"){
      const row=await db.execute({sql:"SELECT fcm_token FROM sessions WHERE id=? LIMIT 1",args:[me.sessionId]});
      return respond(res,200,{deviceRegistered:!!row.rows[0]?.fcm_token,serverCredentialsConfigured:!!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,vapidConfigured:!!process.env.VITE_FIREBASE_VAPID_KEY,projectId:process.env.VITE_FIREBASE_PROJECT_ID||null});
    }
    if(action==="push-test"&&req.method==="POST"){
      const result=await pushTo(me.userId,"Chatly","Las notificaciones están conectadas correctamente.",{type:"test"});
      if(!result.configured)return respond(res,503,{error:"Falta FIREBASE_SERVICE_ACCOUNT_JSON: configura la cuenta de servicio de Firebase Admin en el servidor."});
      if(!result.sent)return respond(res,409,{error:result.reason==="no-device-token"?"Este dispositivo todavía no registró su token de notificaciones.":"Firebase no pudo entregar la notificación de prueba.",...result});
      return respond(res,200,{ok:true,...result});
    }
    if(action==="contacts"&&req.method==="GET"){
      const rows=await db.execute({sql:`SELECT u.id,u.display_name AS name,u.chat_number AS number,u.status_text AS status,
        (SELECT body FROM messages m WHERE (m.sender_id=u.id AND m.recipient_id=? ) OR (m.sender_id=? AND m.recipient_id=u.id) ORDER BY created_at DESC LIMIT 1) AS preview,
        (SELECT created_at FROM messages m WHERE (m.sender_id=u.id AND m.recipient_id=? ) OR (m.sender_id=? AND m.recipient_id=u.id) ORDER BY created_at DESC LIMIT 1) AS last_time
        FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.user_id=? ORDER BY COALESCE(last_time,c.created_at) DESC`,args:[me.userId,me.userId,me.userId,me.userId,me.userId]});
      return respond(res,200,{contacts:rows.rows});
    }
    if(action==="contacts"&&req.method==="POST"){
      const n=String(req.body?.chatNumber||"").trim();
      const found=await db.execute({sql:"SELECT id FROM users WHERE chat_number=? LIMIT 1",args:[n]});
      if(!found.rows[0])return respond(res,404,{error:"No encontramos una cuenta con ese número de Chatly."});
      const other=String(found.rows[0].id);if(other===me.userId)return respond(res,400,{error:"No puedes agregarte a ti mismo."});
      const blocked=await db.execute({sql:"SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)",args:[me.userId,other,other,me.userId]});
      if(blocked.rows.length)return respond(res,403,{error:"No se puede agregar este contacto."});
      await db.execute({sql:"INSERT OR IGNORE INTO contacts(user_id,contact_id,created_at) VALUES(?,?,?)",args:[me.userId,other,new Date().toISOString()]});
      await db.execute({sql:"INSERT OR IGNORE INTO contacts(user_id,contact_id,created_at) VALUES(?,?,?)",args:[other,me.userId,new Date().toISOString()]});
      return respond(res,200,{ok:true});
    }
    if(action==="messages"&&req.method==="GET"){
      const peer=String(req.query.with||"");const before=String(req.query.before||"");
      const since=String(req.query.since||"");const wait=String(req.query.wait||"")==="1";
      const queryMessages=()=>db.execute({sql:`SELECT m.id,m.sender_id,m.recipient_id,m.body,m.kind,m.created_at,m.edited_at,m.deleted_at,m.read_at,u.display_name AS sender_name
        FROM messages m JOIN users u ON u.id=m.sender_id
        WHERE ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?))
        AND (?='' OR m.created_at<?) AND (?='' OR m.created_at>=?)
        ORDER BY m.created_at DESC LIMIT 100`,
        args:[me.userId,peer,peer,me.userId,before,before,since,since]});
      let rows=await queryMessages();
      if(wait&&!rows.rows.length){
        const deadline=Date.now()+20000;
        while(Date.now()<deadline&&!rows.rows.length){
          await new Promise(resolve=>setTimeout(resolve,900));
          rows=await queryMessages();
        }
      }
      await db.execute({sql:"UPDATE messages SET read_at=? WHERE sender_id=? AND recipient_id=? AND read_at IS NULL",args:[new Date().toISOString(),peer,me.userId]});
      return respond(res,200,{messages:rows.rows.reverse()});
    }
    if(action==="upload"&&req.method==="POST"){
      if(!process.env.BLOB_READ_WRITE_TOKEN)return respond(res,503,{error:"Falta configurar BLOB_READ_WRITE_TOKEN para habilitar archivos."});
      const {fileName,mimeType,data}=req.body||{};
      const safeMime=typeof mimeType==="string"?mimeType.split(";")[0].trim().toLowerCase():"";
      const allowed=/^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/plain|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))|audio\/(webm|ogg|mp4|mpeg|wav|x-wav))$/i;
      if(typeof fileName!=="string"||!allowed.test(safeMime)||typeof data!=="string")return respond(res,400,{error:"Tipo de archivo no admitido."});
      const cleanName=fileName.replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,100)||"archivo";
      const base64=data.replace(/^data:[^;]+;base64,/,"");
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))return respond(res,400,{error:"El archivo no tiene un formato válido."});
      const bytes=Buffer.from(base64,"base64");
      if(!bytes.length||bytes.length>2.5*1024*1024)return respond(res,413,{error:"Cada archivo debe pesar como máximo 2.5 MB."});
      const {put}=await import("@vercel/blob");
      const blob=await put(`chatly/${me.userId}/${Date.now()}-${cleanName}`,bytes,{access:"public",addRandomSuffix:true,contentType:safeMime,token:process.env.BLOB_READ_WRITE_TOKEN});
      return respond(res,201,{url:blob.url,size:bytes.length,fileName:cleanName,mimeType:safeMime});
    }
    if(action==="messages"&&req.method==="POST"){
      const {to,body,kind="text"}=req.body||{};
      if(typeof body!=="string"||!body.trim()||body.length>5000||!["text","image","file","audio"].includes(String(kind)))return respond(res,400,{error:"El mensaje está vacío, es demasiado largo o tiene un tipo no válido."});
      const target=await db.execute({sql:"SELECT id,display_name FROM users WHERE id=? LIMIT 1",args:[String(to)]});
      if(!target.rows[0])return respond(res,404,{error:"Contacto no encontrado."});
      const blocked=await db.execute({sql:"SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)",args:[me.userId,String(to),String(to),me.userId]});
      if(blocked.rows.length)return respond(res,403,{error:"No se pudo enviar el mensaje."});
      const msgId=id(),created=new Date().toISOString();
      await db.execute({sql:"INSERT INTO messages(id,sender_id,recipient_id,body,kind,created_at) VALUES(?,?,?,?,?,?)",args:[msgId,me.userId,String(to),body.trim(),String(kind),created]});
      await pushTo(String(to),"Nuevo mensaje de "+me.name,kind==="image"?"Te envió una foto.":kind==="file"?"Te envió un documento.":kind==="audio"?"Te envió una nota de voz.":body.trim().slice(0,100),{type:"message",from:me.userId});
      return respond(res,201,{message:{id:msgId,sender_id:me.userId,recipient_id:String(to),body:body.trim(),kind,created_at:created}});
    }
    if(action==="message-edit"&&req.method==="POST"){
      const {messageId,body}=req.body||{};
      if(typeof messageId!=="string"||!messageId||typeof body!=="string"||!body.trim()||body.trim().length>5000)
        return respond(res,400,{error:"El mensaje no puede estar vacío y debe tener como máximo 5000 caracteres."});
      const r=await db.execute({sql:"UPDATE messages SET body=?,edited_at=? WHERE id=? AND sender_id=? AND deleted_at IS NULL",args:[body.trim(),new Date().toISOString(),messageId,me.userId]});
      if(!Number(r.rowsAffected))return respond(res,404,{error:"No se encontró un mensaje editable de tu cuenta."});
      return respond(res,200,{ok:true,updated:true});
    }
    if(action==="message-delete"&&req.method==="POST"){
      const {messageId}=req.body||{};
      if(typeof messageId!=="string"||!messageId)return respond(res,400,{error:"Falta el identificador del mensaje."});
      const r=await db.execute({sql:"UPDATE messages SET body='Mensaje eliminado',deleted_at=? WHERE id=? AND sender_id=? AND deleted_at IS NULL",args:[new Date().toISOString(),messageId,me.userId]});
      if(!Number(r.rowsAffected))return respond(res,404,{error:"No se encontró un mensaje eliminable de tu cuenta."});
      return respond(res,200,{ok:true});
    }
    if(action==="groups"&&req.method==="GET"){
      const rows=await db.execute({sql:"SELECT g.id,g.name,g.description,g.invite_code,gm.role,(SELECT COUNT(*) FROM group_members x WHERE x.group_id=g.id) AS members FROM group_members gm JOIN chat_groups g ON g.id=gm.group_id WHERE gm.user_id=? ORDER BY g.created_at DESC",args:[me.userId]});
      return respond(res,200,{groups:rows.rows});
    }
    if(action==="groups"&&req.method==="POST"){
      const name=String(req.body?.name||"").trim().slice(0,60);if(!name)return respond(res,400,{error:"Escribe un nombre para el grupo."});
      const groupId=id(),invite=token(6).toUpperCase(),created=new Date().toISOString();
      await db.execute({sql:"INSERT INTO chat_groups(id,name,owner_id,invite_code,created_at) VALUES(?,?,?,?,?)",args:[groupId,name,me.userId,invite,created]});
      await db.execute({sql:"INSERT INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,?,?)",args:[groupId,me.userId,"admin",created]});
      return respond(res,201,{group:{id:groupId,name,invite_code:invite,role:"admin",members:1}});
    }
    if(action==="groups-join"&&req.method==="POST"){
      const code=String(req.body?.inviteCode||"").trim().toUpperCase();
      const g=await db.execute({sql:"SELECT id FROM chat_groups WHERE invite_code=? LIMIT 1",args:[code]});
      if(!g.rows[0])return respond(res,404,{error:"Código de invitación no válido."});
      await db.execute({sql:"INSERT OR IGNORE INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,?,?)",args:[g.rows[0].id,me.userId,"member",new Date().toISOString()]});
      return respond(res,200,{ok:true});
    }
    if(action==="channels"&&req.method==="GET"){
      const rows=await db.execute({sql:"SELECT c.id,c.name,c.description,c.created_at,(SELECT COUNT(*) FROM channel_posts p WHERE p.channel_id=c.id) AS posts FROM channels c WHERE c.public=1 ORDER BY c.created_at DESC LIMIT 100"});
      return respond(res,200,{channels:rows.rows});
    }
    if(action==="channels"&&req.method==="POST"){
      const name=String(req.body?.name||"").trim().slice(0,60);const description=String(req.body?.description||"").slice(0,240);
      if(!name)return respond(res,400,{error:"Escribe un nombre para el canal."});
      const channelId=id(),created=new Date().toISOString();
      await db.execute({sql:"INSERT INTO channels(id,name,description,owner_id,created_at) VALUES(?,?,?,?,?)",args:[channelId,name,description,me.userId,created]});
      return respond(res,201,{channel:{id:channelId,name,description}});
    }
    if(action==="channel-post"&&req.method==="POST"){
      const {channelId,body}=req.body||{};const c=await db.execute({sql:"SELECT id FROM channels WHERE id=? AND owner_id=?",args:[String(channelId),me.userId]});
      if(!c.rows.length)return respond(res,403,{error:"Solo el propietario puede publicar en este canal por ahora."});
      await db.execute({sql:"INSERT INTO channel_posts(id,channel_id,author_id,body,created_at) VALUES(?,?,?,?,?)",args:[id(),String(channelId),me.userId,String(body||"").slice(0,3000),new Date().toISOString()]});
      return respond(res,201,{ok:true});
    }
    if(action==="status"&&req.method==="GET"){
      const rows=await db.execute({sql:"SELECT s.id,s.body,s.media_url,s.created_at,u.id AS user_id,u.display_name AS name,u.chat_number AS number FROM statuses s JOIN users u ON u.id=s.user_id WHERE s.expires_at>? AND (s.user_id=? OR s.user_id IN (SELECT contact_id FROM contacts WHERE user_id=?)) ORDER BY s.created_at DESC",args:[new Date().toISOString(),me.userId,me.userId]});
      return respond(res,200,{statuses:rows.rows});
    }
    if(action==="status"&&req.method==="POST"){
      const body=String(req.body?.body||"").trim().slice(0,500);if(!body)return respond(res,400,{error:"Escribe un estado."});
      const created=new Date(),expires=new Date(created.getTime()+24*60*60*1000);
      await db.execute({sql:"INSERT INTO statuses(id,user_id,body,created_at,expires_at) VALUES(?,?,?,?,?)",args:[id(),me.userId,body,created.toISOString(),expires.toISOString()]});
      return respond(res,201,{ok:true});
    }
    if(action==="profile"&&req.method==="POST"){
      const status=String(req.body?.status||"Disponible").slice(0,80);
      await db.execute({sql:"UPDATE users SET status_text=? WHERE id=?",args:[status,me.userId]});
      return respond(res,200,{ok:true});
    }
    if(action==="block"&&req.method==="POST"){
      const target=String(req.body?.userId||"");if(target===me.userId)return respond(res,400,{error:"Acción no válida."});
      await db.execute({sql:"INSERT OR IGNORE INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)",args:[me.userId,target,new Date().toISOString()]});
      await db.execute({sql:"DELETE FROM contacts WHERE (user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?)",args:[me.userId,target,target,me.userId]});
      return respond(res,200,{ok:true});
    }
    if(action==="report"&&req.method==="POST"){
      const target=String(req.body?.userId||"");const reason=String(req.body?.reason||"").slice(0,500);
      if(!target||!reason)return respond(res,400,{error:"Indica el usuario y el motivo."});
      await db.execute({sql:"INSERT INTO reports(id,reporter_id,target_id,reason,created_at) VALUES(?,?,?,?,?)",args:[id(),me.userId,target,reason,new Date().toISOString()]});
      return respond(res,201,{ok:true});
    }
    if(action==="pin"&&req.method==="POST"){
      const messageId=String(req.body?.messageId||"");
      await db.execute({sql:"INSERT OR IGNORE INTO pinned_messages(user_id,message_id,created_at) VALUES(?,?,?)",args:[me.userId,messageId,new Date().toISOString()]});
      return respond(res,200,{ok:true});
    }
    return respond(res,404,{error:"Ruta no encontrada."});
  }catch(error:any){
    console.error("Chatly API:",error);
    return respond(res,error?.status||500,{error:error?.message||"Error interno de Chatly."});
  }
}