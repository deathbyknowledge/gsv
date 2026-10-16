import * as z from "zod/mini";

const domain = z.string().check(z.minLength(1), z.maxLength(253), z.refine((value) => {
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value && url.host === value && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}, "Expected a normalized domain name"));
const url = z.string().check(z.maxLength(2048), z.refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch { return false; }
}, "Expected an HTTPS URL"));
const origin = url.check(z.refine((value) => new URL(value).origin === value, "Expected an origin"));

/** Public operator metadata. It carries no credentials or installation authority. */
export type PublicDeploymentConfig = {
  primaryDomain?: string;
  sitesDomain?: string;
  legacyDomains: string[];
  operatorName?: string;
  accountsOrigin?: string;
  docsUrl?: string;
  installUrl?: string;
  termsUrl?: string;
  privacyUrl?: string;
};

export const deploymentPresentationSchema = z.object({
  primaryDomain: z.optional(domain),
  sitesDomain: z.optional(domain),
  legacyDomains: z._default(z.array(domain).check(z.maxLength(16)), []),
  operatorName: z.optional(z.string().check(z.minLength(1), z.maxLength(160))),
  accountsOrigin: z.optional(origin),
  docsUrl: z.optional(url),
  installUrl: z.optional(url),
  termsUrl: z.optional(url),
  privacyUrl: z.optional(url),
}) satisfies z.ZodMiniType<PublicDeploymentConfig>;

export const DEPLOYMENT_PRESENTATION_PATH = "/.well-known/gsv/deployment.json";
export const DEPLOYMENT_PRESENTATION_ELEMENT = "gsv-deployment";

export function deploymentPresentation(value?: string): PublicDeploymentConfig {
  return deploymentPresentationSchema.parse(value ? JSON.parse(value) : {});
}

export function deploymentDomains(presentation: PublicDeploymentConfig): string[] {
  return [...new Set([...(presentation.primaryDomain ? [presentation.primaryDomain] : []), ...presentation.legacyDomains])];
}

export function configuredDomainAliases(value?: string): string[] {
  return z.array(domain).check(z.maxLength(16)).parse(value ? JSON.parse(value) : []);
}

export function configuredOriginAliases(value?: string): string[] {
  return z.array(origin).check(z.maxLength(16)).parse(value ? JSON.parse(value) : []);
}

export function deploymentPresentationScript(presentation: PublicDeploymentConfig): string {
  return `<script type="application/json" id="${DEPLOYMENT_PRESENTATION_ELEMENT}">${JSON.stringify(presentation).replace(/</g, "\\u003c")}</script>`;
}
