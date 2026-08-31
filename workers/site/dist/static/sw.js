// Give Food Service Worker for VAPID Web Push Notifications
// This file handles standard Web Push API notifications

self.addEventListener('push', function(event) {
    console.log('[Service Worker] Push received:', event);

    let data = {};
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data = { body: event.data.text() };
        }
    }

    const title = data.head || data.title || 'Give Food';
    const options = {
        body: data.body || '',
        icon: data.icon || '/static/img/notificationicon.svg',
        badge: '/static/img/notificationicon.svg',
        tag: data.tag || 'give-food-notification',
        data: {
            url: data.url || '/needs/'
        }
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification clicked:', event);
    event.notification.close();

    const url = event.notification.data && event.notification.data.url
        ? event.notification.data.url
        : '/needs/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            // If there's an existing window, focus it and navigate
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if ('focus' in client) {
                    return client.focus().then(function(focusedClient) {
                        if ('navigate' in focusedClient) {
                            return focusedClient.navigate(url);
                        }
                    });
                }
            }
            // Otherwise open a new window
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});

// Activate immediately when installed
self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(clients.claim());
});
