import { describe, expect, it } from "vitest";
import {
  parseLinkManagedTelegramActorInput,
  parseUnlinkManagedTelegramActorInput,
} from "./telegram";

describe("managed Telegram Gateway boundary", () => {
  it("accepts only one direct Telegram actor and surface", () => {
    expect(parseLinkManagedTelegramActorInput({
      operationId: "operation_link_1",
      installationId: "inst_test",
      principalId: "principal_test",
      localUid: 1000,
      actorId: "123456",
      surfaceId: "123456",
    })).toMatchObject({ actorId: "123456", surfaceId: "123456" });

    expect(() => parseLinkManagedTelegramActorInput({
      operationId: "operation_link_1",
      installationId: "inst_test",
      principalId: "principal_test",
      localUid: 1000,
      actorId: "123456",
      surfaceId: "999999",
    })).toThrow("direct messages only");
  });

  it("rejects standalone, malformed actors, and unsafe uids", () => {
    expect(() => parseUnlinkManagedTelegramActorInput({
      operationId: "operation_unlink_1",
      installationId: "singleton",
      actorId: "123456",
      surfaceId: "123456",
      expectedLocalUid: 1000,
    })).toThrow("cannot address singleton");
    expect(() => parseUnlinkManagedTelegramActorInput({
      operationId: "operation_unlink_1",
      installationId: "inst_test",
      actorId: "@alice",
      surfaceId: "@alice",
      expectedLocalUid: 1000,
    })).toThrow("actorId is invalid");
  });
});
