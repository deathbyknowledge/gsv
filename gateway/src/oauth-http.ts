export type OAuthClientMetadata = {
  client_id: string;
  client_name: string;
  application_type: "web";
  response_types: ["code"];
  grant_types: ["authorization_code", "refresh_token"];
  token_endpoint_auth_method: "none";
  redirect_uris: string[];
  code_challenge_methods_supported: ["S256"];
};

export type OAuthCallbackRenderResult =
  | {
      ok: true;
      account: {
        provider: string;
        label: string | null;
      };
    }
  | {
      ok: false;
      message: string;
    };

export function buildOAuthClientMetadata(origin: string): OAuthClientMetadata {
  const clientId = `${origin}/.well-known/oauth-client/gsv.json`;
  return {
    client_id: clientId,
    client_name: "GSV",
    application_type: "web",
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    redirect_uris: [`${origin}/oauth/callback`],
    code_challenge_methods_supported: ["S256"],
  };
}

export function renderOAuthCallbackHtml(result: OAuthCallbackRenderResult): string {
  const title = result.ok ? "OAuth connection complete" : "OAuth connection failed";
  const detail = result.ok
    ? `Connected ${result.account.label ?? result.account.provider}. You can close this tab.`
    : result.message;
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;background:#0f172a;color:#e2e8f0}",
    "main{max-width:32rem;padding:2rem}",
    "h1{font-size:1.35rem;line-height:1.2;margin:0 0 .75rem}",
    "p{line-height:1.5;color:#cbd5e1;margin:0}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(detail)}</p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

export function oauthCallbackHtmlResponse(
  result: OAuthCallbackRenderResult,
  status = result.ok ? 200 : 400,
): Response {
  return new Response(renderOAuthCallbackHtml(result), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
