**Hosting consolidation means one public GSV stack that any operator can deploy, supporting one or several isolated installations. H&M will run that same stack.**

Today, GSV has two hosting paths: the historical standalone/singleton deployment for someone’s own Cloudflare account, and the managed deployment used by H&M. They differ in provisioning, identity routing, onboarding, and messenger configuration. Maintaining both creates duplicate code and inconsistent user flows.

The new web UI has now shipped. We deliberately avoided rebuilding the old per-user messenger application setup screens because consolidation changes who owns that configuration.

The target architecture has three boundaries:

| Boundary | Owns |
|---|---|
| **Deployment/operator** | Cloudflare resources, domains, installation administration, messenger applications, optional shared services |
| **Installation** | Local accounts, agents, conversations, files, memory, credentials, permissions, machines, linked external identities |
| **Local account** | A human or agent’s identity and access within an installation |

A solo self-hoster runs this stack with one installation. An operator can provision several. Registration defaults to closed; supporting multiple installations does not require opening a public signup service.

The implementation has five main parts:

1. **Make the reusable installation services public.** Extract the installation directory, bootstrap/onboarding, and operator administration from the private Accounts service into GSV. H&M should consume that implementation. Operator-specific commercial policy and credentials remain separate. Existing public service contracts and shared deployment code provide the starting point.

2. **Provide one deployment and bootstrap flow.** Configure the domain, operator access, enabled adapters, optional services, and secret references. Create the first installation and issue a one-time setup link; provide explicit administration for additional installations. User-supplied inference credentials must support a useful installation independently of H&M services. Operator-funded inference, mail, and telemetry remain optional.

3. **Unify messenger setup and linking.** The operator configures the provider application or bot and its credentials. Individual people then authorize and link their external identities at runtime. For example, H&M configures its Telegram bot; a self-hoster configures theirs; both users follow the same linking flow. Existing managed Telegram and Slack implementations are the foundation, with corresponding work needed for Discord. The UI presents available integrations according to service availability and permissions. Provider identity, transport, retries, and delivery behavior remain adapter-owned.

4. **Reduce H&M infrastructure to a small composition of public components.** Shared provisioning belongs in GSV. The private Alchemy configuration keeps H&M’s domains, administrator configuration, environment policy, secret bindings, and overrides needed to preserve existing resources.

5. **Remove the obsolete standalone path completely.** Once the common flow works, remove singleton addressing, alternate adapter entrypoints, duplicated setup flows, hosting-mode branches, and obsolete documentation/tests. Update the engineering contract to reflect the deliberate cutover.

Throughout this work, **the immutable installation ID remains the security boundary**. Trusted hostname routing must resolve an installation before accessing its Kernel; arbitrary hostnames must never allocate state. Processes, conversations, storage, repositories, and adapter routes must remain installation-scoped.

Existing managed installations must retain their identities and data. Extracting deployment code must also preserve Alchemy resource identities and retention behavior. For legacy singleton deployments, the agreed approach is to identify actual remaining users, preserve a last standalone release, and arrange any necessary migration or recovery explicitly. We expect very few users, so a general automatic migration framework is not the starting assumption.

**The first milestone is a fresh deployment using public components only, with two installations, normal onboarding, Telegram linking, and user-supplied model credentials.** Validation should deliberately reuse local usernames and paths across both installations, verify isolation of state and messaging, and confirm that restarting, resetting, or deleting one does not affect the other. H&M’s deployment must consume the same public components successfully.

WhatsApp Business is the agreed future WhatsApp transport, but its implementation is a separate follow-up. iMessage comes later. Send-tool changes remain parked, and no license change is part of this work; GSV remains MIT.

The direction is recorded in the [hosting consolidation plan](https://github.com/deathbyknowledge/gsv/blob/main/engineering/unified-hosting-and-web-release.md).
