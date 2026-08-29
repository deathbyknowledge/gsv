type SignedSlackRequestInput = {
  url: string;
  signingSecret: string;
  contentType: string;
  body: string;
};

export async function signedSlackRequest(
  input: SignedSlackRequestInput,
): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${input.body}`),
  ));
  const signature = `v0=${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  return new Request(input.url, {
    method: "POST",
    headers: {
      "Content-Type": input.contentType,
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    body: input.body,
  });
}
