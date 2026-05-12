import { describe, expect, it } from "vitest";
import {
  PdsClient,
  proxyPdsXrpcRequest,
  type PdsCreateRecordInput,
  type PdsServiceBinding,
} from "./client";
import {
  SPACE_GSV_PROFILE,
  type SpaceGsvProfileRecord,
} from "@gsv/protocol/syscalls/social";

describe("PdsClient", () => {
  it("uses service-binding RPC for internal record writes", async () => {
    const calls: PdsCreateRecordInput[] = [];
    const binding = {
      fetch: async () => {
        throw new Error("public fetch should not be used for internal writes");
      },
      pdsCreateRecord: async (input: PdsCreateRecordInput) => {
        calls.push(input);
        return {
          uri: "at://did:web:gsv.example/space.gsv.profile/self",
          cid: "bafy-record",
          commit: {
            cid: "bafy-commit",
            rev: "3ltest",
          },
        };
      },
    } as unknown as PdsServiceBinding;

    const record: SpaceGsvProfileRecord = {
      $type: SPACE_GSV_PROFILE,
      createdAt: "2026-05-12T12:00:00Z",
      displayName: "Hank",
    };
    const client = new PdsClient(binding);
    const result = await client.createRecord({
      host: "gsv.example",
      repo: "did:web:gsv.example",
      collection: SPACE_GSV_PROFILE,
      rkey: "self",
      record,
      validate: true,
    });

    expect(calls).toEqual([
      {
        host: "gsv.example",
        repo: "did:web:gsv.example",
        collection: SPACE_GSV_PROFILE,
        rkey: "self",
        record,
        validate: true,
      },
    ]);
    expect(result).toEqual({
      uri: "at://did:web:gsv.example/space.gsv.profile/self",
      cid: "bafy-record",
      commit: {
        cid: "bafy-commit",
        rev: "3ltest",
      },
      validationStatus: undefined,
    });
  });

  it("proxies public xrpc requests through fetch without buffering the response", async () => {
    const binding = {
      fetch: async (request: Request) => {
        return new Response(JSON.stringify({
          url: request.url,
          method: request.method,
          body: await request.text(),
        }), {
          headers: { "content-type": "application/json" },
        });
      },
    } as unknown as PdsServiceBinding;

    const response = await proxyPdsXrpcRequest(
      new Request("https://gsv.example/xrpc/com.atproto.repo.getRecord?repo=did:web:gsv.example", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      }),
      { PDS: binding } as unknown as Env,
    );

    expect(await response.json()).toEqual({
      url: "https://gsv.example/xrpc/com.atproto.repo.getRecord?repo=did:web:gsv.example",
      method: "POST",
      body: "{\"ok\":true}",
    });
  });

  it("accepts deleteRecord responses that only include a commit ref", async () => {
    const binding = {
      pdsDeleteRecord: async () => ({
        commit: {
          cid: "bafy-commit",
          rev: "3ldelete",
        },
      }),
    } as unknown as PdsServiceBinding;

    const client = new PdsClient(binding);
    await expect(client.deleteRecord({
      host: "gsv.example",
      repo: "did:web:gsv.example",
      collection: SPACE_GSV_PROFILE,
      rkey: "self",
    })).resolves.toEqual({
      uri: undefined,
      cid: undefined,
      commit: {
        cid: "bafy-commit",
        rev: "3ldelete",
      },
      validationStatus: undefined,
    });
  });

  it("normalizes ensureAccount responses from the PDS binding", async () => {
    const binding = {
      pdsEnsureAccount: async () => ({
        did: "did:web:gsv.example",
        handle: "gsv.example",
        created: false,
      }),
    } as unknown as PdsServiceBinding;

    const client = new PdsClient(binding);
    await expect(client.ensureAccount({
      host: "gsv.example",
      handle: "gsv.example",
      password: "generated-password",
    })).resolves.toEqual({
      did: "did:web:gsv.example",
      handle: "gsv.example",
      created: false,
    });
  });

  it("throws a clear error when the PDS binding is absent", async () => {
    await expect(() =>
      proxyPdsXrpcRequest(
        new Request("https://gsv.example/xrpc/com.atproto.server.describeServer"),
        {} as Env,
      )
    ).rejects.toThrow("PDS binding is required");
  });
});
