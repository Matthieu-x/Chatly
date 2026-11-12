# Chatly — proyecto en desarrollo

Esta entrega contiene frontend React, una API serverless para Vercel, esquema de base de datos autoinicializable en Turso y envío de notificaciones push con Firebase Cloud Messaging.

## Funciones implementadas en el código
- Registro con nombre, país y elección entre seis números ficticios generados por servidor.
- Reserva única de número en base de datos (si otra cuenta lo toma antes, se solicita elegir otro).
- Inicio de sesión con número ficticio y código de recuperación generado una sola vez.
- Una sesión activa por cuenta; al iniciar sesión en otro dispositivo se revoca la anterior.
- Contactos por número Chatly, mensajes privados guardados en Turso y actualización por sondeo.
- Notificación push FCM al recibir mensajes.
- Grupos: creación, códigos de invitación y membresía.
- Canales públicos y publicación del propietario.
- Estados que expiran en 24 horas.
- Perfil/estado, bloqueo, reportes, mensajes editables/eliminables desde la interfaz y API, y fijado.
- Acciones para editar o eliminar mensajes propios, con validación de propiedad y contenido en el servidor.
- Creación de grupos con campo de nombre visible y código de invitación mostrado.
- Generación de identificadores con límite de intentos para evitar bucles si quedan pocos disponibles.
- Ventana personalizada de permisos push; el permiso real lo muestra el navegador.
- Tema oscuro y claro.
- API concentrada en un solo archivo `api/index.ts`.

## Requisitos externos que no se pueden crear desde este ZIP
1. Crear en Turso una base NUEVA llamada `chatly`, obtener URL y token.
2. Crear proyecto y aplicación web en Firebase; activar Cloud Messaging y generar clave Web Push (VAPID).
3. Crear una cuenta de servicio Firebase Admin para el backend.
4. Añadir variables en `.env` local y en Vercel.
5. Desplegar a Vercel.

## Instalación local
- Node.js 20 o superior.
- `npm install`
- Completar `.env`.
- `npm run dev` (la API serverless no se ejecuta con Vite por sí solo; usar Vercel CLI `vercel dev` para probar frontend + API).
- `npm run build`

## Variables
Consulta `.env`. El archivo está excluido de Git. En Vercel agrega las mismas variables en Project Settings → Environment Variables. Nunca pongas secretos en variables `VITE_`.

## Nota sobre notificaciones
FCM necesita HTTPS y permisos del navegador. En Android, Chrome suele soportar web push; en iOS las notificaciones web dependen de instalar la PWA en pantalla de inicio y de la versión de iOS. El token de FCM se guarda en la sesión del dispositivo, no en el número ficticio.

## Funciones multimedia y sincronización añadidas

- Mensajes directos con espera larga (long polling) para recibir mensajes nuevos sin esperar a un ciclo fijo de consulta. La interfaz mantiene además la actualización de contactos.
- Envío de imágenes, documentos PDF/TXT/Word/Excel/PowerPoint y notas de voz grabadas desde el navegador.
- Los archivos se almacenan en Vercel Blob y se comparten como mensajes del chat. Límite actual: 2.5 MB por archivo.
- El navegador necesita permiso de micrófono para grabar notas de voz.

## Trabajo pendiente antes de producción pública
- La sincronización usa long polling, no WebSockets. Para escalabilidad alta conviene un servicio realtime dedicado.
- Los archivos en Vercel Blob usan URL pública no adivinable; no se debe tratar como almacenamiento privado ni como cifrado de extremo a extremo.
- Llamadas de audio/vídeo no están implementadas.
- No se anuncia cifrado de extremo a extremo: HTTPS protege el transporte, pero el contenido se guarda en Turso y no es E2EE.
- Hay que añadir límites antiabuso, CAPTCHA/rate limiting, moderación de reportes, paginación, controles de grupos y pruebas de seguridad antes de abrir el registro al público.
- Los códigos de recuperación se muestran una sola vez. El usuario debe guardarlos; no existe recuperación por correo/SMS.
- La generación de números utiliza prefijos y longitudes nacionales aproximadas como identidad ficticia; no son números telefónicos válidos garantizados ni se conectan a redes telefónicas.

## Estructura mínima
```
Chatly/
  api/
    index.ts
  .env
  .gitignore
  chatly-icon.svg
  firebase-messaging-sw.js
  index.html
  package.json
  README.md
  src.tsx
  styles.css
  tsconfig.json
  vercel.json
  vite.config.ts
```
La carpeta `api/` es necesaria para que Vercel detecte la función serverless. No hay carpetas adicionales de componentes o utilidades.


## Cambios recientes
- Se conectaron los controles de edición y eliminación de mensajes propios con sus rutas de API.
- El servidor ahora rechaza ediciones vacías, demasiado largas o sobre mensajes que no pertenecen al usuario.
- La eliminación solo se permite una vez y solo sobre mensajes propios.
- El formulario de grupos ahora permite escribir el nombre y muestra el código para invitar a otras personas.
- La búsqueda de números tiene un máximo de intentos y devuelve un error claro si no encuentra identificadores.

## Estado de verificación
El ZIP contiene el código fuente actualizado. La instalación de dependencias no terminó en el entorno de trabajo, por lo que todavía no se ha podido ejecutar `npm run build` ni una prueba integrada contra Turso/Firebase. No considerar esta entrega lista para producción hasta completar esas verificaciones y configurar los servicios externos.


**Importante sobre tiempo real:** el chat usa long polling sobre la API y Turso, no WebSockets. Mantiene una petición abierta hasta 20 segundos y devuelve mensajes cuando aparecen; es una sincronización rápida, pero no equivale a una conexión WebSocket persistente.


## Credenciales recuperadas de la configuración acordada

- Turso: la URL de la base de datos y su token de autenticación proporcionados para Chatly ya están colocados en el `.env` local.
- Firebase Web Push: la clave proporcionada está colocada como `VITE_FIREBASE_VAPID_KEY`. Para completar la configuración web todavía hacen falta los valores de Firebase Web App (`API_KEY`, `AUTH_DOMAIN`, `PROJECT_ID`, `MESSAGING_SENDER_ID` y `APP_ID`). Para enviar notificaciones desde el servidor también hace falta la cuenta de servicio de Firebase Admin (`FIREBASE_SERVICE_ACCOUNT_JSON`).
- Sendlib: no se utiliza en esta versión, según la decisión posterior del proyecto.
- El `.env` permanece excluido de Git mediante `.gitignore`; no subirlo a GitHub ni compartirlo públicamente.


## Base de datos y notificaciones configuradas

- Turso se conecta mediante `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`. Al primer acceso a la API, `initDb()` crea las 13 tablas e índices con `CREATE TABLE/INDEX IF NOT EXISTS`; no borra los datos existentes.
- `GET /api?action=health` comprueba la conexión real con Turso, cuántas tablas del esquema existen y si están presentes las variables web de Firebase, VAPID y Firebase Admin.
- La configuración web de Firebase ya está puesta en el `.env` local usando los valores entregados para el proyecto `edward-85dde`. La clave VAPID existente se conserva.
- Al activar notificaciones, el navegador obtiene el token FCM y la API lo guarda en `sessions.fcm_token` asociado a la sesión activa. Al iniciar sesión de nuevo, si el permiso ya está concedido, Chatly vuelve a registrar el token.
- Los mensajes directos llaman a Firebase Admin para enviar push. `GET /api?action=push-status` revisa el registro del dispositivo y `POST /api?action=push-test` envía una notificación de prueba.

### Credencial privada que falta para enviar push

El objeto `firebaseConfig` del navegador y la clave VAPID no permiten enviar notificaciones desde el servidor. Para habilitar el envío, genera una clave de cuenta de servicio en Firebase Console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada. Guarda el JSON completo como una sola variable `FIREBASE_SERVICE_ACCOUNT_JSON` en `.env` local y en Vercel. No publiques ese JSON ni lo pongas en variables `VITE_`. Debe pertenecer al mismo proyecto `edward-85dde`.

En Vercel también debes crear las variables `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, todas las `VITE_FIREBASE_*` (incluida `VITE_FIREBASE_VAPID_KEY`), `FIREBASE_SERVICE_ACCOUNT_JSON` y `SESSION_SECRET`, y luego desplegar de nuevo. El `.env` local no se copia automáticamente a Vercel.

`npm install` y la compilación completa no se pudieron verificar en este entorno porque la instalación de dependencias agotó el tiempo de espera.
