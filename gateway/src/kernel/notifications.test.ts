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
    procs: {
      getOwnerUid: vi.fn(() => 1000),
    } as unknown as KernelContext["procs"],
    broadcastToUserUid: vi.fn(),
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
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(
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
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(
      1000,
      "notification.updated",
      expect.anything(),
    );

    const dismissResult = handleNotificationDismiss({ notificationId: "notif-1" }, ctx);
    expect(dismissResult.notification?.dismissedAt).toBe(2);
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(
      1000,
      "notification.dismissed",
      expect.anything(),
    );
  });

  it("stores and broadcasts process notifications for the owning user", () => {
    const base = makeContext({ processId: "proc-builder" });
    const ctx = makeContext({
      ...base,
      identity: {
        ...base.identity!,
        process: { ...base.identity!.process, uid: 2000 },
      },
      processId: "proc-builder",
    });

    handleNotificationCreate({ title: "Build finished" }, ctx);
    handleNotificationList({}, ctx);
    handleNotificationMarkRead({ notificationId: "notif-1" }, ctx);
    handleNotificationDismiss({ notificationId: "notif-1" }, ctx);

    expect(ctx.procs.getOwnerUid).toHaveBeenCalledWith("proc-builder");
    expect(ctx.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ uid: 1000 }));
    expect(ctx.notifications.list).toHaveBeenCalledWith(1000, {});
    expect(ctx.notifications.markRead).toHaveBeenCalledWith(1000, "notif-1");
    expect(ctx.notifications.dismiss).toHaveBeenCalledWith(1000, "notif-1");
    expect(ctx.broadcastToUserUid).toHaveBeenCalledTimes(3);
    for (const [uid] of (ctx.broadcastToUserUid as ReturnType<typeof vi.fn>).mock.calls) {
      expect(uid).toBe(1000);
    }
  });
});
