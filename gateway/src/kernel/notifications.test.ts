import { describe, expect, it, vi } from "vitest";
import {
  handleNotificationCreate,
  handleNotificationDismiss,
  handleNotificationList,
  handleNotificationMarkRead,
} from "./notifications";
import type { KernelContext } from "./context";

function makeContext(overrides: Partial<KernelContext> = {}): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "hank",
        home: "/home/hank",
        cwd: "/home/hank",
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    notifications: {
      create: vi.fn((input) => ({
        notificationId: "notif-1",
        title: input.title,
        body: input.body,
        level: input.level,
        createdAt: 1,
        readAt: null,
        dismissedAt: null,
        expiresAt: input.expiresAt,
        actions: input.actions,
        source: input.source,
      })),
      list: vi.fn(() => [{
        notificationId: "notif-1",
        title: "Build finished",
        body: "product-alpha is ready",
        level: "success",
        createdAt: 1,
        readAt: null,
        dismissedAt: null,
        expiresAt: 2,
        actions: [],
        source: { kind: "user" },
      }]),
      markRead: vi.fn(() => ({
        notificationId: "notif-1",
        title: "Build finished",
        body: "product-alpha is ready",
        level: "success",
        createdAt: 1,
        readAt: 2,
        dismissedAt: null,
        expiresAt: 3,
        actions: [],
        source: { kind: "user" },
      })),
      dismiss: vi.fn(() => ({
        notificationId: "notif-1",
        title: "Build finished",
        body: "product-alpha is ready",
        level: "success",
        createdAt: 1,
        readAt: null,
        dismissedAt: 2,
        expiresAt: 3,
        actions: [],
        source: { kind: "user" },
      })),
    } as unknown as KernelContext["notifications"],
    broadcastToUid: vi.fn(),
    ...overrides,
  } as KernelContext;
}

describe("notification handlers", () => {
  it("creates a notification and broadcasts notification.created", () => {
    const ctx = makeContext({
      processId: "proc-builder",
    });

    const result = handleNotificationCreate({
      title: "Wiki build finished",
      body: "product-alpha is ready",
      level: "success",
    }, ctx);

    expect(result.notification.notificationId).toBe("notif-1");
    expect(ctx.notifications?.create).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      title: "Wiki build finished",
      level: "success",
      source: {
        kind: "process",
        processId: "proc-builder",
      },
    }));
    expect(ctx.broadcastToUid).toHaveBeenCalledWith(
      1000,
      "notification.created",
      expect.objectContaining({
        notification: expect.objectContaining({
          notificationId: "notif-1",
        }),
      }),
    );
  });

  it("lists notifications for the current user", () => {
    const ctx = makeContext();

    const result = handleNotificationList({ limit: 10 }, ctx);

    expect(result.notifications).toHaveLength(1);
    expect(ctx.notifications?.list).toHaveBeenCalledWith(1000, { limit: 10 });
  });

  it("marks notifications read and dismissed with the right signals", () => {
    const ctx = makeContext();

    const readResult = handleNotificationMarkRead({ notificationId: "notif-1" }, ctx);
    expect(readResult.notification?.readAt).toBe(2);
    expect(ctx.broadcastToUid).toHaveBeenCalledWith(
      1000,
      "notification.updated",
      expect.anything(),
    );

    const dismissResult = handleNotificationDismiss({ notificationId: "notif-1" }, ctx);
    expect(dismissResult.notification?.dismissedAt).toBe(2);
    expect(ctx.broadcastToUid).toHaveBeenCalledWith(
      1000,
      "notification.dismissed",
      expect.anything(),
    );
  });
});
