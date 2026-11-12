/* Chatly Firebase background notifications. Firebase web config is public. */
importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js");

self.addEventListener("install", (event) => event.waitUntil(Promise.all([self.skipWaiting(), initMessaging()])));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

let messagingReady = false;
async function initMessaging() {
  if (messagingReady) return;
  try {
    const response = await fetch("/api?action=public-config");
    const config = await response.json();
    if (!config.firebase || !config.firebase.apiKey || !config.firebase.projectId || !config.firebase.messagingSenderId || !config.firebase.appId) return;
    if (!firebase.apps.length) firebase.initializeApp(config.firebase);
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage((payload) => {
      const title = payload.notification?.title || "Nuevo mensaje en Chatly";
      const options = {
        body: payload.notification?.body || "Tienes una nueva notificación.",
        icon: "/chatly-icon.svg",
        badge: "/chatly-icon.svg",
        data: payload.data || { url: "/" }
      };
      self.registration.showNotification(title, options);
    });
    messagingReady = true;
  } catch (error) {
    console.error("Chatly push worker:", error);
  }
}
self.addEventListener("push", (event) => {
  event.waitUntil(initMessaging());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ("focus" in client) { client.navigate(target); return client.focus(); }
    }
    return self.clients.openWindow(target);
  }));
});