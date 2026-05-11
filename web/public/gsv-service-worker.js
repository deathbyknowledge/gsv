self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    if (event.data) {
      const text = event.data.text();
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {
          title: "GSV",
          body: text,
        };
      }
    }

    const title = typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim()
      : "GSV";
    const body = typeof payload.body === "string" ? payload.body : undefined;
    const notificationId = typeof payload.notificationId === "string" ? payload.notificationId : undefined;
    const url = typeof payload.url === "string" && payload.url.trim() ? payload.url.trim() : null;

    await self.registration.showNotification(title, {
      body,
      tag: notificationId,
      data: {
        notificationId,
        url,
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    const rawUrl = event.notification.data?.url;
    const targetUrl = typeof rawUrl === "string" && rawUrl.trim()
      ? new URL(rawUrl, self.location.origin).href
      : null;
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    for (const client of windows) {
      if ("focus" in client) {
        const targetClient = targetUrl && client.url !== targetUrl && "navigate" in client
          ? (await client.navigate(targetUrl).catch(() => null)) || client
          : client;
        await targetClient.focus();
        targetClient.postMessage({
          type: "gsv.notification.click",
          notificationId: event.notification.data?.notificationId ?? null,
          url: targetUrl,
        });
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl || "/");
    }
  })());
});
